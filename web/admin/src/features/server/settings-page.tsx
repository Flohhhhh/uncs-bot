import { useEffect, useRef, useState } from "react";
import {
  settingFields,
  settingValue,
  type MapSelection,
  type SettingsSnapshot,
  type SettingValue,
} from "../../../../../src/common/server-settings";
import { canAct } from "../../../../../src/common/admin-policy";
import { useGameAdmin as useAdmin } from "../../app/context";
import { useResource } from "../../api/use-resource";
import { useGameApi } from "../../api/server-client";
import type { ActionResult, Catalog } from "../../api/types";
import { Badge, Card, Empty, Modal, ReasonField, Table } from "../../components/ui";
import { errorMessage, rejectionState, singleLine } from "../actions/policy";
import { MapPicker } from "../actions/map-picker";

const timing: Record<string, string> = {
  live: "Live",
  applied: "Live",
  "next-match": "Next match",
  "next-restart": "Server restart",
  pending: "Pending",
  overridden: "Host override",
  unknown: "Checked on save",
};
type DraftAction =
  | { action: "settings-save"; revision: string; changes: Record<string, SettingValue> }
  | { action: "rotation-save"; revision: string; entries: MapSelection[] }
  | { action: "map-next"; revision: string; currentIndex: number; currentMap: string; entry: MapSelection };
function ReviewChanges({
  action,
  summary,
  close,
  finished,
}: {
  action: DraftAction;
  summary: string[];
  close: () => void;
  finished: () => void;
}) {
  const admin = useAdmin();
  const api = useGameApi();
  const [id] = useState(() => crypto.randomUUID());
  const submitted = useRef(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (admin.busy || submitted.current) return;
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    if (!singleLine(reason, 3)) return;
    submitted.current = true;
    admin.setBusy(true);
    try {
      const response = await api<ActionResult>("actions", {
        method: "POST",
        body: JSON.stringify({ ...action, id, reason }),
      });
      setResult({
        ...response,
        state: ["applied", "accepted", "pending", "failed", "unknown"].includes(response.state)
          ? response.state
          : "unknown",
      });
    } catch (error) {
      setResult({
        state: rejectionState(error),
        message: `${errorMessage(error)} Check action ${id} in Action history before trying again.`,
      });
    } finally {
      admin.setBusy(false);
      admin.invalidateOverview();
      finished();
    }
  }
  return (
    <Modal serverScoped title="Review server changes" onClose={close} busy={admin.busy}>
      <ul className="change-summary">
        {summary.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
      {result ? (
        <>
          <p
            className={`notice ${result.state === "failed" || result.state === "unknown" ? "warning" : "info"}`}
            role="status"
          >
            {result.message}
          </p>
          <p className="muted">Receipt: {id}</p>
          <button type="button" onClick={close} className="button secondary">
            Close
          </button>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <ReasonField />
          <div className="dialog-actions">
            <button type="button" disabled={admin.busy} onClick={close} className="button secondary">
              Cancel
            </button>
            <button className="button primary" disabled={admin.busy}>
              {admin.busy ? "Saving…" : "Confirm changes"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
function RotationEditor({
  snapshot,
  reload,
  disabled,
  active,
  onUnsavedChange,
}: {
  snapshot: SettingsSnapshot;
  reload: () => void;
  disabled: boolean;
  active: boolean;
  onUnsavedChange: (value: boolean) => void;
}) {
  const { data: catalog, error } = useResource<Catalog>(active ? "catalog" : null);
  const [draft, setDraft] = useState<{ revision: string; entries: MapSelection[] } | null>(null);
  const [selection, setSelection] = useState<MapSelection>({ map: "", experiences: [] });
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [review, setReview] = useState<{ action: DraftAction; summary: string[] } | null>(null);
  const entries = draft?.entries ?? snapshot.rotation.entries;
  const locked = disabled || !snapshot.rotation.editable;
  const changedElsewhere = draft && draft.revision !== snapshot.revision;
  useEffect(() => onUnsavedChange(!!draft), [draft, onUnsavedChange]);
  function update(next: MapSelection[]) {
    setDraft({ revision: draft?.revision ?? snapshot.revision, entries: next });
  }
  const summarize = (entry: MapSelection) =>
    [entry.map, ...entry.experiences, entry.lighting, entry.zoneAlternator].filter(Boolean).join(" · ");
  return (
    <Card
      title="Map rotation"
      subtitle="Queue the next round or edit the saved rotation."
      badge={<Badge>{snapshot.rotation.mode || "Unknown"}</Badge>}
    >
      <div className="card-body">
        {snapshot.rotation.note && <p className="notice warning">{snapshot.rotation.note}</p>}
        {changedElsewhere && (
          <p className="notice warning">Server settings changed. Discard this draft and reload before saving.</p>
        )}
        <ol className="rotation-editor">
          {entries.map((entry, index) => (
            <li key={index}>
              <div>
                <strong>{entry.map}</strong>
                <small>
                  {[...entry.experiences, entry.lighting, entry.zoneAlternator].filter(Boolean).join(" · ") ||
                    "Map defaults"}
                </small>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  disabled={locked || editIndex !== null || index === 0}
                  aria-label={`Move ${entry.map} up`}
                  onClick={() => {
                    const next = [...entries];
                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                    update(next);
                  }}
                  className="button secondary"
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={locked || editIndex !== null || index === entries.length - 1}
                  aria-label={`Move ${entry.map} down`}
                  onClick={() => {
                    const next = [...entries];
                    [next[index + 1], next[index]] = [next[index], next[index + 1]];
                    update(next);
                  }}
                  className="button secondary"
                >
                  ↓
                </button>
                <button
                  type="button"
                  disabled={locked || editIndex !== null}
                  onClick={() => {
                    setSelection(entry);
                    setEditIndex(index);
                    update([...entries]);
                  }}
                  className="button secondary"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={locked || editIndex !== null}
                  aria-label={`Remove ${entry.map}`}
                  onClick={() => update(entries.filter((_, i) => i !== index))}
                  className="button secondary"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
        {draft && (
          <div className="toolbar">
            <button
              className="button primary"
              disabled={locked || !!changedElsewhere || entries.length === 0 || editIndex !== null}
              onClick={() =>
                setReview({
                  action: { action: "rotation-save", ...draft },
                  summary: entries.map((entry, index) => `${index + 1}. ${summarize(entry)}`),
                })
              }
            >
              Review rotation
            </button>
            <button
              disabled={disabled}
              onClick={() => {
                setDraft(null);
                setEditIndex(null);
                reload();
              }}
              className="button secondary"
            >
              Discard draft
            </button>
          </div>
        )}
        {error && <p className="notice warning">{error}</p>}
        {catalog && (
          <>
            <MapPicker value={selection} change={setSelection} catalog={catalog} disabled={locked} />
            <div className="toolbar">
              <button
                disabled={locked || !selection.map || (editIndex === null && entries.length >= 100)}
                onClick={() => {
                  update(
                    editIndex === null
                      ? [...entries, selection]
                      : entries.map((entry, index) => (index === editIndex ? selection : entry)),
                  );
                  setEditIndex(null);
                }}
                className="button secondary"
              >
                {editIndex === null ? "Add to rotation" : "Update entry"}
              </button>
              <button
                className="button primary"
                disabled={
                  locked ||
                  !!draft ||
                  !selection.map ||
                  !snapshot.rotation.enabled ||
                  snapshot.rotation.mode !== "Ordered" ||
                  snapshot.rotation.currentIndex === null
                }
                onClick={() =>
                  setReview({
                    action: {
                      action: "map-next",
                      revision: snapshot.revision,
                      currentIndex: snapshot.rotation.currentIndex!,
                      currentMap: snapshot.rotation.currentMap,
                      entry: selection,
                    },
                    summary: [
                      `Next round: ${summarize(selection)}`,
                      "Updates the saved ordered rotation. The current match continues.",
                    ],
                  })
                }
              >
                Queue next map
              </button>
            </div>
            {editIndex !== null && (
              <button
                className="button secondary"
                type="button"
                onClick={() => {
                  setEditIndex(null);
                  setSelection({ map: "", experiences: [] });
                }}
              >
                Cancel entry edit
              </button>
            )}
            <small className="muted">
              Queuing requires an enabled, ordered rotation and no unsaved rotation edits.
            </small>
          </>
        )}
      </div>
      {review && (
        <ReviewChanges
          {...review}
          close={() => setReview(null)}
          finished={() => {
            setDraft(null);
            reload();
          }}
        />
      )}
    </Card>
  );
}
export function SettingsPage() {
  const admin = useAdmin();
  const resource = useResource<SettingsSnapshot>(admin.me.role === "admin" ? "settings" : null);
  const [group, setGroup] = useState("Identity");
  const [draft, setDraft] = useState<{ snapshot: SettingsSnapshot; changes: Record<string, SettingValue> } | null>(
    null,
  );
  const [review, setReview] = useState<{ action: DraftAction; summary: string[] } | null>(null);
  const [validation, setValidation] = useState("");
  const [rotationUnsaved, setRotationUnsaved] = useState(false);
  const { setUnsavedChanges } = admin;
  useEffect(() => setUnsavedChanges(!!draft || rotationUnsaved), [draft, rotationUnsaved, setUnsavedChanges]);
  useEffect(() => () => setUnsavedChanges(false), [setUnsavedChanges]);
  if (admin.me.role !== "admin") return <Empty title="Administrator access required" />;
  if (!resource.data) return <Empty title={resource.error || "Loading server settings…"} />;
  const snapshot = draft?.snapshot ?? resource.data;
  const disabled = admin.busy || !!resource.error || document.hidden;
  const outdated = !!draft && draft.snapshot.revision !== resource.data.revision;
  const counts = Object.keys(draft?.changes ?? {}).length;
  const update = (id: string, value: SettingValue) => {
    setValidation("");
    setDraft((old) => ({ snapshot: old?.snapshot ?? resource.data!, changes: { ...old?.changes, [id]: value } }));
  };
  function reviewSettings() {
    if (!draft) return;
    try {
      const summary = Object.entries(draft.changes).map(([id, value]) => {
        const field = settingFields.find((entry) => entry.id === id)!;
        settingValue(field, value);
        return `${field.label}: ${field.secret ? "Password updated" : String(value)}`;
      });
      setReview({
        action: { action: "settings-save", revision: draft.snapshot.revision, changes: draft.changes },
        summary,
      });
    } catch (error) {
      setValidation(errorMessage(error));
    }
  }
  return (
    <>
      {resource.error && (
        <p className="notice error" role="alert">
          {resource.error}
        </p>
      )}
      {snapshot.notice && <p className="notice warning">{snapshot.notice}</p>}
      {outdated && (
        <p className="notice warning">Settings changed on the server. Discard your draft and reload before saving.</p>
      )}
      <div className="settings-tabs" role="group" aria-label="Setting groups">
        {["Identity", "Joining", "Gameplay", "Rotation", "Host controls"].map((name) => (
          <button key={name} aria-pressed={group === name} onClick={() => setGroup(name)} className="button secondary">
            {name}
          </button>
        ))}
      </div>
      {group !== "Host controls" && (
        <Card title={group} badge={<Badge>{counts ? `${counts} unsaved` : "Saved configuration"}</Badge>}>
          <div className="card-body settings-grid">
            {settingFields
              .filter((field) => field.group === group)
              .map((field) => {
                const observed = snapshot.fields.find((entry) => entry.id === field.id);
                const value = draft?.changes[field.id] ?? observed?.value ?? "";
                const locked = disabled || !observed?.editable;
                return (
                  <label key={field.id}>
                    {field.label}
                    <span className="setting-timing">
                      {observed?.editable ? timing[observed.state] || timing.unknown : "Read-only"}
                    </span>
                    {field.type === "boolean" || field.type === "select" ? (
                      <select
                        value={String(value)}
                        disabled={locked}
                        onChange={(event) =>
                          update(
                            field.id,
                            field.type === "boolean" ? event.target.value === "true" : event.target.value,
                          )
                        }
                      >
                        <option value="" disabled>
                          Not set in file
                        </option>
                        {(field.type === "boolean" ? ["true", "false"] : field.options!).map((option) => (
                          <option key={option} value={option}>
                            {option === "true" ? "On" : option === "false" ? "Off" : option}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={
                          field.type === "password"
                            ? "password"
                            : field.type === "number"
                              ? "number"
                              : field.type === "url"
                                ? "url"
                                : "text"
                        }
                        autoComplete={field.secret ? "new-password" : "off"}
                        value={String(value)}
                        placeholder={field.secret ? "Leave unchanged" : "Not set in file"}
                        disabled={locked}
                        min={field.id === "scorePeriod" ? snapshot.scoreTick?.min : field.min}
                        max={
                          field.id === "scorePeriod"
                            ? snapshot.scoreTick?.max
                            : field.type === "number"
                              ? field.max
                              : undefined
                        }
                        maxLength={field.type !== "number" ? field.max : undefined}
                        step={field.type === "number" ? 1 : undefined}
                        onChange={(event) =>
                          update(
                            field.id,
                            field.type === "number"
                              ? event.target.value === ""
                                ? ""
                                : Number(event.target.value)
                              : event.target.value,
                          )
                        }
                      />
                    )}
                    <small>{observed?.note || field.help}</small>
                    {field.id === "scorePeriod" && snapshot.scoreTick && (
                      <small>
                        Running: {snapshot.scoreTick.current}s · Allowed: {snapshot.scoreTick.min}–
                        {snapshot.scoreTick.max}s
                      </small>
                    )}
                    {field.secret && (
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={locked}
                        onClick={() => update(field.id, "")}
                      >
                        Clear join password
                      </button>
                    )}
                  </label>
                );
              })}
          </div>
        </Card>
      )}
      {counts > 0 && (
        <div className="settings-savebar">
          <strong>
            {counts} unsaved change{counts === 1 ? "" : "s"}
          </strong>
          <button
            disabled={disabled}
            onClick={() => {
              setDraft(null);
              setValidation("");
              resource.refresh();
            }}
            className="button secondary"
          >
            Discard
          </button>
          <button className="button primary" disabled={disabled || outdated} onClick={reviewSettings}>
            Review changes
          </button>
        </div>
      )}
      {validation && (
        <p className="notice error" role="alert">
          {validation}
        </p>
      )}
      <div hidden={group !== "Rotation"}>
        <RotationEditor
          snapshot={resource.data}
          reload={resource.refresh}
          disabled={disabled || !!draft}
          active={group === "Rotation"}
          onUnsavedChange={setRotationUnsaved}
        />
      </div>
      {group === "Host controls" && (
        <Card
          className="host-controls"
          title="Managed through the host"
          subtitle="These controls do not have a verified dashboard connection."
        >
          <div className="card-body">
            <Table label="Host controls" headers={["CONTROL", "WHERE IT BELONGS"]} scrollable>
              <tr>
                <td>Daily restart time</td>
                <td>xREALM Schedules. Confirm its timezone and next run; the game's separate daily time uses UTC.</td>
              </tr>
              <tr>
                <td>Restart after the match</td>
                <td>
                  xREALM has a match-end restart task with announcements.{" "}
                  <a
                    href="https://www.xrealm.com/en/blog/wardogs-server-restart-after-match-end"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Setup guide ↗
                  </a>
                </td>
              </tr>
              <tr>
                <td>RCON AllowedHosts, listener, port, password and TLS</td>
                <td>Host configuration. Credentials and network access stay out of this dashboard.</td>
              </tr>
              <tr>
                <td>Game-event feed destination</td>
                <td>Host integration settings. Preserve the existing receiver until a cutover is tested.</td>
              </tr>
              <tr>
                <td>Server description</td>
                <td>No verified game configuration key in the current official template.</td>
              </tr>
            </Table>
            <p className="muted">
              Use the selected server's host panel. This dashboard does not read or change host schedules. Restart match
              only reloads the round.
            </p>
          </div>
        </Card>
      )}
      {review && (
        <ReviewChanges
          {...review}
          close={() => setReview(null)}
          finished={() => {
            setDraft(null);
            resource.refresh();
          }}
        />
      )}
    </>
  );
}
export function PermissionsPage() {
  const { me, server } = useAdmin();
  const rows = [
    ["Player moderation & announcements", "kick"],
    ["Whitelist & map controls", "map"],
    ["Server settings & rotation", "settings-save"],
  ] as const;
  return (
    <Card
      title="Staff permissions"
      subtitle={`Your access${server ? ` on ${server.name}` : ""}: ${me.role}. Assigned through configured Discord roles.`}
    >
      <div className="card-body">
        <Table label="Staff access by role" headers={["ACCESS", "VIEWER", "MODERATOR", "ADMIN / OWNER"]} scrollable>
          <tr>
            <td>Server, players & action history</td>
            <td>Read</td>
            <td>Read</td>
            <td>Read</td>
          </tr>
          {rows.map(([label, action]) => (
            <tr key={action}>
              <td>{label}</td>
              {(["viewer", "moderator", "admin"] as const).map((role) => (
                <td key={role}>{canAct(role, action) ? "Manage" : "—"}</td>
              ))}
            </tr>
          ))}
          <tr>
            <td>Private applications for this server</td>
            <td>—</td>
            <td>—</td>
            <td>Manage</td>
          </tr>
          <tr>
            <td>Create, close & review Discord map ballots</td>
            <td>—</td>
            <td>—</td>
            <td>Manage</td>
          </tr>
          <tr>
            <td>Start, stop & restore optional 50v50 events</td>
            <td>—</td>
            <td>—</td>
            <td>Manage</td>
          </tr>
        </Table>
        <p className="muted">
          Members, supporters and founders receive no staff controls automatically. Owners currently share the admin
          permission level. Discord role assignment remains with the community’s owners.
        </p>
        <p className="muted">Screened Discord members can vote in a published ballot. Voting grants no staff access.</p>
        <p className="muted">
          Server restrictions can narrow a staff role. Supporter records use community-wide administrator access and do
          not grant game access.
        </p>
      </div>
    </Card>
  );
}
