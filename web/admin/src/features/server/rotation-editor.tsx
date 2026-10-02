import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { MapSelection, SettingsSnapshot } from "../../../../../src/common/server-settings";
import { sameMap, selectionLabel } from "../../../../../src/common/map-labels";
import { useResource } from "../../api/use-resource";
import type { Catalog } from "../../api/types";
import { Badge, Card } from "../../components/ui";
import { MapPicker } from "../actions/map-picker";
import { SavedRotationCheck } from "./rotation-check";
import { nextRoundSummary } from "./next-round";
import { ReviewChanges, type DraftAction } from "./settings-page";
import type { RotationMarkers, RotationRow } from "./rotation-queue";
const RotationQueue = lazy(() => import("./rotation-queue").then((module) => ({ default: module.RotationQueue })));

const emptySelection = (): MapSelection => ({ map: "", experiences: [] });

/**
 * Match & maps' map planning: `view="next"` queues the round after this match; `view="rotation"` edits the
 * saved rotation as a draft that is reviewed before saving.
 */
export function RotationEditor({
  snapshot,
  reload,
  disabled,
  active,
  view,
  onUnsavedChange,
  onEditingChange,
}: {
  snapshot: SettingsSnapshot;
  reload: () => void;
  disabled: boolean;
  active: boolean;
  view: "next" | "rotation";
  onUnsavedChange: (value: boolean) => void;
  /** Reports an entry edit in progress, which keeps the next-round view closed. */
  onEditingChange?: (editing: boolean) => void;
}) {
  const { data: catalog, error, loading, refresh: refreshCatalog } = useResource<Catalog>(active ? "catalog" : null);
  const savedRows = useMemo(
    () => snapshot.rotation.entries.map((entry, index) => ({ id: snapshot.revision + ":" + index, entry })),
    [snapshot],
  );
  const [draft, setDraft] = useState<{ revision: string; baseEntries: string; rows: RotationRow[] } | null>(null);
  // The entry open in the editor: a row, or "end" for a new entry.
  const [editing, setEditing] = useState<number | "end" | null>(null);
  const [selection, setSelection] = useState(emptySelection);
  const [ready, setReady] = useState(false);
  const [editBase, setEditBase] = useState<string | null>(null);
  const [nextSelection, setNextSelection] = useState(emptySelection);
  const [nextReady, setNextReady] = useState(false);
  const [review, setReview] = useState<{ action: DraftAction; summary: string[] } | null>(null);
  const rows = draft?.rows ?? savedRows;
  const entries = rows.map((row) => row.entry);
  const savedEntries = JSON.stringify(snapshot.rotation.entries);
  const changedElsewhere = (draft?.baseEntries ?? editBase ?? savedEntries) !== savedEntries;
  const locked = disabled || !snapshot.rotation.editable || changedElsewhere || !!review;
  const editIndex = typeof editing === "number" ? editing : null;
  const selectionChanged =
    editing === "end"
      ? !!selection.map
      : editIndex !== null && JSON.stringify(selection) !== JSON.stringify(entries[editIndex]);
  useEffect(() => onUnsavedChange(!!draft || selectionChanged), [draft, selectionChanged, onUnsavedChange]);
  useEffect(() => onEditingChange?.(editIndex !== null), [editIndex, onEditingChange]);
  function update(next: RotationRow[]) {
    if (locked) return;
    setDraft(
      JSON.stringify(next.map((row) => row.entry)) === JSON.stringify(snapshot.rotation.entries)
        ? null
        : {
            revision: draft?.revision ?? snapshot.revision,
            baseEntries: draft?.baseEntries ?? savedEntries,
            rows: next,
          },
    );
  }
  function closeEditor() {
    setEditing(null);
    setEditBase(null);
    setSelection(emptySelection());
  }
  function saveEntry() {
    if (locked || !ready || loading || error) return;
    if (editing === "end") {
      if (rows.length >= 100) return;
      update([...rows, { id: crypto.randomUUID(), entry: structuredClone(selection) }]);
    } else if (editIndex !== null)
      update(rows.map((row, index) => (index === editIndex ? { ...row, entry: structuredClone(selection) } : row)));
    closeEditor();
  }
  const { currentIndex } = snapshot.rotation;
  const ordered = snapshot.rotation.enabled && snapshot.rotation.mode === "Ordered";
  const currentMatches =
    currentIndex !== null && sameMap(snapshot.rotation.entries[currentIndex]?.map, snapshot.rotation.currentMap);
  const summary = nextRoundSummary(snapshot);
  // Now and Next mark saved rows only, and only where the game confirms the position.
  const markers: RotationMarkers | undefined =
    draft || changedElsewhere
      ? undefined
      : {
          now: summary.state === "saved" ? currentIndex : null,
          next: summary.state === "saved" || summary.state === "game-next" ? summary.index : null,
        };
  const editor = catalog ? (
    <MapPicker
      value={selection}
      change={setSelection}
      catalog={catalog}
      disabled={locked || loading || !!error}
      onReadyChange={setReady}
    >
      <button
        type="button"
        className="button primary"
        disabled={locked || !ready || loading || !!error || (editing === "end" && rows.length >= 100)}
        onClick={saveEntry}
      >
        {editing === "end" ? "Add to rotation" : "Update entry"}
      </button>
      <button type="button" className="button secondary" disabled={disabled} onClick={closeEditor}>
        {editing === "end" ? "Cancel new entry" : "Cancel entry edit"}
      </button>
    </MapPicker>
  ) : (
    <div className="map-picker-status">
      {error ? "Map choices are unavailable." : "Loading map choices…"}
      <button type="button" className="button secondary small" disabled={disabled} onClick={closeEditor}>
        {editing === "end" ? "Cancel new entry" : "Cancel entry edit"}
      </button>
    </div>
  );
  return (
    <>
      <Card
        title={view === "next" ? "Queue the next round" : "Map rotation"}
        subtitle={
          view === "next"
            ? "Choose what plays after this match."
            : "Edit the ongoing schedule. Changes stay in a draft until saved."
        }
        badge={<Badge>{snapshot.rotation.mode || "Unknown"}</Badge>}
      >
        <div className="card-body">
          {snapshot.rotation.note && <p className="notice warning">{snapshot.rotation.note}</p>}
          {ordered && !currentMatches && (
            <div className="notice warning">
              <p>
                {snapshot.rotation.positionNote ||
                  "The current place in the rotation is unavailable. Refresh to try again."}
              </p>
              <button type="button" className="button secondary" disabled={disabled || !!review} onClick={reload}>
                Refresh map position
              </button>
            </div>
          )}
          {active && view === "rotation" && <SavedRotationCheck revision={snapshot.revision} />}
          {changedElsewhere && (
            <p className="notice warning">
              The saved rotation changed. Your draft is kept, but cannot overwrite a newer rotation. Compare it before
              discarding and reloading.
            </p>
          )}
          {draft && !changedElsewhere && draft.revision !== snapshot.revision && (
            <p className="notice info">
              Other settings changed. Your map edits are kept and will use the latest settings.
            </p>
          )}
          {error && (
            <div className="notice warning" role="alert">
              <p>{error}</p>
              <button
                type="button"
                className="button secondary small"
                disabled={disabled || loading}
                onClick={refreshCatalog}
              >
                Retry map choices
              </button>
            </div>
          )}
          {view === "next" ? (
            <>
              {draft ? (
                <p className="notice warning">
                  Your rotation has unsaved edits. Save or discard them in Rotation before choosing the next round.
                </p>
              ) : (
                !ordered && (
                  <p className="muted">Enable an ordered rotation in Server settings to choose the next round.</p>
                )
              )}
              {!catalog && !error && loading && <p role="status">Loading map choices…</p>}
              {catalog && (
                <MapPicker
                  value={nextSelection}
                  change={setNextSelection}
                  catalog={catalog}
                  disabled={locked || loading || !!error}
                  onReadyChange={setNextReady}
                >
                  <button
                    type="button"
                    className="button primary"
                    disabled={
                      locked ||
                      !nextReady ||
                      loading ||
                      !!error ||
                      !!draft ||
                      editIndex !== null ||
                      !ordered ||
                      !currentMatches
                    }
                    onClick={() =>
                      setReview({
                        action: {
                          action: "map-next",
                          revision: snapshot.revision,
                          currentIndex: currentIndex!,
                          currentMap: snapshot.rotation.currentMap,
                          entry: structuredClone(nextSelection),
                        },
                        summary: [
                          "Next round: " + selectionLabel(nextSelection),
                          "Updates the saved ordered rotation. The current match continues.",
                        ],
                      })
                    }
                  >
                    Queue next map
                  </button>
                </MapPicker>
              )}
            </>
          ) : (
            <Suspense fallback={<p>Loading rotation editor…</p>}>
              <RotationQueue
                rows={rows}
                change={update}
                disabled={locked || editIndex !== null}
                canEdit={!locked && editing === null}
                markers={markers}
                editing={editIndex}
                editor={editor}
                edit={(index) => {
                  if (locked || editing !== null) return;
                  setSelection(structuredClone(entries[index]));
                  setEditing(index);
                  setEditBase(draft?.baseEntries ?? savedEntries);
                }}
              >
                {editing === "end" ? (
                  <div className="rotation-add">{editor}</div>
                ) : (
                  <button
                    type="button"
                    className="button secondary rotation-add-button"
                    disabled={locked || editing !== null || rows.length >= 100}
                    onClick={() => {
                      setSelection(emptySelection());
                      setEditing("end");
                    }}
                  >
                    + Add map
                  </button>
                )}
              </RotationQueue>
            </Suspense>
          )}
        </div>
      </Card>
      {(draft || changedElsewhere) && view === "rotation" && (
        <div className="settings-savebar">
          <strong>Unsaved rotation · {rows.length} rounds</strong>
          <button
            type="button"
            className="button secondary"
            disabled={disabled}
            onClick={() => {
              setDraft(null);
              closeEditor();
              reload();
            }}
          >
            Discard draft
          </button>
          <button
            type="button"
            className="button primary"
            disabled={locked || entries.length === 0 || editIndex !== null}
            onClick={() =>
              setReview({
                action: { action: "rotation-save", revision: snapshot.revision, entries: structuredClone(entries) },
                summary: entries.map((entry, index) => index + 1 + ". " + selectionLabel(entry)),
              })
            }
          >
            Review rotation
          </button>
        </div>
      )}
      {review && (
        <ReviewChanges
          {...review}
          close={() => setReview(null)}
          finished={(state) => {
            if (state !== "failed") setDraft(null);
            reload();
          }}
        />
      )}
    </>
  );
}
