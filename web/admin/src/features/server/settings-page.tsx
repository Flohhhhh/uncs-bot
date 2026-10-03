import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  settingFields,
  settingValue,
  type MapSelection,
  type SettingField,
  type SettingsSnapshot,
  type SettingValue,
} from "../../../../../src/common/server-settings";
import { canAct } from "../../../../../src/common/admin-policy";
import { useGameAdmin as useAdmin } from "../../app/context";
import { useResource } from "../../api/use-resource";
import { useGameApi } from "../../api/server-client";
import type { ActionResult } from "../../api/types";
import { Card, Empty, Modal, Table, Tabs } from "../../components/ui";
import { ActionReceipt } from "../actions/action-receipt";
import { errorMessage, rejectionState } from "../actions/policy";
import { ServerIdentityReadout } from "./server-identity";

const timing: Record<string, string> = {
  live: "Now",
  applied: "Now",
  "next-match": "Next match",
  "next-restart": "Server restart",
  pending: "Pending",
  overridden: "Host override",
  unknown: "Checked on save",
};
const timingSymbol: Record<string, string> = { live: "⚡", applied: "⚡", "next-match": "⏭", "next-restart": "↻" };
/** Review headings by when a change takes effect, in the order staff read them. */
const reviewTiming: [string, string[]][] = [
  ["Applies now", ["live", "applied"]],
  ["Next match", ["next-match"]],
  ["After restart", ["next-restart"]],
  ["Pending", ["pending"]],
  ["Host override", ["overridden"]],
];
const groups = ["Identity", "Joining", "Gameplay", "Rotation", "Host controls"] as const;
type Group = (typeof groups)[number];
const saveLabels = { "settings-save": "Save settings", "rotation-save": "Save rotation", "map-next": "Queue next map" };
export type DraftAction =
  | { action: "settings-save"; revision: string; changes: Record<string, SettingValue> }
  | { action: "rotation-save"; revision: string; entries: MapSelection[] }
  | {
      action: "map-next";
      revision: string;
      currentIndex: number;
      currentMap: string;
      entry: MapSelection;
    };
export type ReviewGroup = { title: string; items: string[] };

function shown(id: string, input: SettingValue | null | undefined) {
  return input === null || input === undefined || input === ""
    ? "Not set"
    : typeof input === "boolean"
      ? input
        ? "On"
        : "Off"
      : `${input}${id === "scorePeriod" ? "s" : ""}`;
}

/** The single review for settings, rotation and next-round saves. */
export function ReviewChanges({
  action,
  summary,
  groups,
  close,
  finished,
}: {
  action: DraftAction;
  summary: string[];
  /** Settings changes grouped by when they take effect; replaces `summary`. */
  groups?: ReviewGroup[];
  close: () => void;
  finished: (state: ActionResult["state"]) => void;
}) {
  const admin = useAdmin();
  const api = useGameApi();
  const [id] = useState(() => crypto.randomUUID());
  const submitted = useRef(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (admin.busy || submitted.current) return;
    submitted.current = true;
    admin.setBusy(true);
    let outcome: ActionResult;
    try {
      const response = await api<ActionResult>("actions", {
        method: "POST",
        body: JSON.stringify({ ...action, id, reason: "Staff reviewed server changes." }),
      });
      outcome = {
        ...response,
        state: ["applied", "accepted", "pending", "failed", "unknown"].includes(response.state)
          ? response.state
          : "unknown",
      };
    } catch (error) {
      outcome = {
        state: rejectionState(error),
        message: errorMessage(error),
      };
    } finally {
      admin.setBusy(false);
      admin.invalidateOverview();
    }
    setResult(outcome);
    finished(outcome.state);
  }
  return (
    <Modal
      serverScoped
      title={saveLabels[action.action]}
      onClose={close}
      busy={admin.busy}
      eyebrow={result ? null : undefined}
    >
      {!result && action.action === "rotation-save" && <p>Saves the ongoing rotation. The current match continues.</p>}
      {groups ? (
        groups.map((group, index) => (
          <div className="change-group" key={group.title}>
            <h3 id={`${id}-group-${index}`}>{group.title}</h3>
            <ul className="change-summary" aria-labelledby={`${id}-group-${index}`}>
              {group.items.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <ul className="change-summary">
          {summary.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )}
      {result ? (
        <>
          <p
            className={`notice ${result.state === "failed" || result.state === "unknown" ? "warning" : "info"}`}
            role="status"
          >
            {result.message}
          </p>
          {result.state === "unknown" && <p>Check this receipt in Action history before trying again.</p>}
          <ActionReceipt id={id} />
          <button type="button" onClick={close} className="button secondary">
            {result.state === "failed" ? "Back to edits" : "Close"}
          </button>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <div className="dialog-actions">
            <button type="button" disabled={admin.busy} onClick={close} className="button secondary">
              Cancel
            </button>
            <button className="button primary" disabled={admin.busy}>
              {admin.busy ? "Saving…" : saveLabels[action.action]}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function SettingInput({
  field,
  snapshot,
  value,
  locked,
  removing,
  update,
}: {
  field: SettingField;
  snapshot: SettingsSnapshot;
  value: SettingValue;
  locked: boolean;
  /** The join password is marked for removal. */
  removing: boolean;
  update: (id: string, value: SettingValue, clearPassword?: boolean) => void;
}) {
  const controlId = `setting-${field.id}`;
  const help = `${controlId}-help`;
  const range = field.id === "scorePeriod" ? snapshot.scoreTick : null;
  if (field.type === "boolean")
    return (
      <div className="setting-switch">
        <input
          id={controlId}
          type="checkbox"
          role="switch"
          className="switch"
          aria-describedby={help}
          checked={value === true}
          disabled={locked}
          onChange={(event) => update(field.id, event.target.checked)}
        />
        {typeof value === "boolean" ? (
          <span aria-hidden="true">{value ? "On" : "Off"}</span>
        ) : (
          <span>Not set in file</span>
        )}
      </div>
    );
  if (field.type === "select")
    return (
      <select
        id={controlId}
        aria-describedby={help}
        value={String(value)}
        disabled={locked}
        onChange={(event) => update(field.id, event.target.value)}
      >
        <option value="" disabled>
          Not set in file
        </option>
        {field.options!.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  if (range)
    return (
      <div className="setting-range">
        <input
          type="range"
          aria-label="Scoring interval slider"
          aria-describedby={help}
          min={range.min}
          max={range.max}
          step={1}
          value={typeof value === "number" ? Math.max(range.min, Math.min(range.max, value)) : range.current}
          aria-valuetext={`${typeof value === "number" ? Math.max(range.min, Math.min(range.max, value)) : range.current} seconds`}
          disabled={locked}
          onChange={(event) => update(field.id, Number(event.target.value))}
        />
        <input
          id={controlId}
          type="number"
          min={range.min}
          max={range.max}
          step={1}
          aria-describedby={help}
          value={String(value)}
          disabled={locked}
          onChange={(event) => update(field.id, event.target.value === "" ? "" : Number(event.target.value))}
        />
        <span aria-hidden="true">s</span>
      </div>
    );
  return (
    <input
      id={controlId}
      aria-describedby={help}
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
      placeholder={field.secret ? (removing ? "Password will be removed" : "Leave unchanged") : "Not set in file"}
      disabled={locked}
      min={field.id === "scorePeriod" ? snapshot.scoreTick?.min : field.min}
      max={field.id === "scorePeriod" ? snapshot.scoreTick?.max : field.type === "number" ? field.max : undefined}
      maxLength={field.type !== "number" ? field.max : undefined}
      step={field.type === "number" ? 1 : undefined}
      onChange={(event) =>
        update(
          field.id,
          field.type === "number" ? (event.target.value === "" ? "" : Number(event.target.value)) : event.target.value,
        )
      }
    />
  );
}

/** Controls the host manages, one line each. */
function HostControls() {
  return (
    <Card
      className="host-controls"
      title="Managed through the host"
      subtitle="Change these in the selected server's host panel."
    >
      <ul className="card-body host-controls-list">
        <li>
          <strong>Daily restart time</strong>
          <span>xREALM Settings. Enter local time; the host stores UTC. Restart the server to apply.</span>
        </li>
        <li>
          <strong>Restart after the match</strong>
          <span>
            xREALM match-end restart task.{" "}
            <a
              href="https://www.xrealm.com/en/blog/wardogs-server-restart-after-match-end"
              target="_blank"
              rel="noopener noreferrer"
            >
              Setup guide ↗
            </a>
          </span>
        </li>
        <li>
          <strong>RCON hosts, port, password and TLS</strong>
          <span>Host configuration. Credentials stay out of this dashboard.</span>
        </li>
        <li>
          <strong>Game-event feed</strong>
          <span>Set the destination in the host panel; check delivery after the next normal start.</span>
        </li>
        <li>
          <strong>Server description</strong>
          <span>The official console keeps it in that browser; the server listing is unchanged.</span>
        </li>
      </ul>
    </Card>
  );
}
export function SettingsPage() {
  const admin = useAdmin();
  const location = useLocation();
  const resource = useResource<SettingsSnapshot>(admin.me.role === "admin" ? "settings" : null);
  const [group, setGroup] = useState<Group>(location.hash === "#rotation" ? "Rotation" : "Identity");
  useEffect(() => {
    if (location.hash === "#rotation") setGroup("Rotation");
  }, [location.hash]);
  const [draft, setDraft] = useState<{ snapshot: SettingsSnapshot; changes: Record<string, SettingValue> } | null>(
    null,
  );
  const [review, setReview] = useState<{ action: DraftAction; summary: string[]; groups: ReviewGroup[] } | null>(null);
  const [validation, setValidation] = useState("");
  const { setUnsavedChanges } = admin;
  useEffect(() => setUnsavedChanges(!!draft), [draft, setUnsavedChanges]);
  useEffect(() => () => setUnsavedChanges(false), [setUnsavedChanges]);
  if (admin.me.role !== "admin") return <Empty title="Administrator access required" />;
  if (!resource.data) return <Empty title={resource.error || "Loading server settings…"} alert={!!resource.error} />;
  const snapshot = draft?.snapshot ?? resource.data;
  const disabled = admin.busy || !!resource.error || document.hidden;
  const outdated = !!draft && draft.snapshot.revision !== resource.data.revision;
  const changes = draft?.changes ?? {};
  const counts = Object.keys(changes).length;
  const changedGroups = new Set(
    Object.keys(changes).map((id) => settingFields.find((field) => field.id === id)?.group),
  );
  const server = new URLSearchParams(location.search).get("server");
  const rotationLink = `/match?${new URLSearchParams(server ? { server, view: "rotation" } : { view: "rotation" })}`;
  const update = (id: string, value: SettingValue, clearPassword = false) => {
    setValidation("");
    setDraft((old) => {
      const original = old?.snapshot ?? resource.data!;
      const changes = { ...old?.changes };
      const secret = settingFields.find((field) => field.id === id)?.secret;
      if (
        (secret && value === "" && !clearPassword) ||
        (!secret && value === original.fields.find((field) => field.id === id)?.value)
      ) {
        delete changes[id];
      } else changes[id] = value;
      return Object.keys(changes).length ? { snapshot: original, changes } : null;
    });
  };
  function reviewSettings() {
    if (!draft) return;
    try {
      const lines = Object.entries(draft.changes).map(([id, value]) => {
        const field = settingFields.find((entry) => entry.id === id)!;
        settingValue(field, value);
        if (
          id === "scorePeriod" &&
          snapshot.scoreTick &&
          (Number(value) < snapshot.scoreTick.min || Number(value) > snapshot.scoreTick.max)
        ) {
          throw new Error(
            `Choose a scoring interval from ${snapshot.scoreTick.min} to ${snapshot.scoreTick.max} seconds.`,
          );
        }
        const before = draft.snapshot.fields.find((entry) => entry.id === id);
        const line = `${field.label}: ${field.secret ? (value === "" ? "Password removed" : "Password updated") : `${shown(id, before?.value)} → ${shown(id, value)}`}`;
        const state = before?.state ?? "unknown";
        return { line, title: reviewTiming.find(([, states]) => states.includes(state))?.[0] ?? timing.unknown };
      });
      const titles = [...reviewTiming.map(([title]) => title), timing.unknown];
      setReview({
        action: { action: "settings-save", revision: draft.snapshot.revision, changes: draft.changes },
        summary: lines.map(({ line }) => line),
        groups: titles
          .map((title) => ({ title, items: lines.filter((entry) => entry.title === title).map(({ line }) => line) }))
          .filter(({ items }) => items.length),
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
      <Tabs
        label="Setting groups"
        tabs={groups.map((name) => ({
          id: name,
          label: changedGroups.has(name) ? (
            <>
              {name}
              <span className="tab-dot" aria-hidden="true">
                •
              </span>
              <span className="sr-only">, unsaved</span>
            </>
          ) : (
            name
          ),
        }))}
        value={group}
        onChange={setGroup}
      >
        {(selected) =>
          selected === "Host controls" ? (
            <HostControls />
          ) : (
            <div className="card">
              <div className="card-body settings-grid">
                {selected === "Identity" && <ServerIdentityReadout />}
                {settingFields
                  .filter((field) => field.group === selected)
                  .map((field) => {
                    const observed = snapshot.fields.find((entry) => entry.id === field.id);
                    const value = changes[field.id] ?? observed?.value ?? "";
                    const controlId = `setting-${field.id}`;
                    const changed = Object.hasOwn(changes, field.id);
                    const removingPassword = !!field.secret && changes[field.id] === "";
                    const was = shown(field.id, observed?.value);
                    return (
                      <div className={`setting-field${changed ? " is-changed" : ""}`} key={field.id}>
                        <div className="setting-head">
                          <label htmlFor={controlId}>{field.label}</label>
                          <span className="setting-timing">
                            {observed?.editable && timingSymbol[observed.state] && (
                              <span aria-hidden="true">{timingSymbol[observed.state]} </span>
                            )}
                            {observed?.editable ? timing[observed.state] || timing.unknown : "Read-only"}
                          </span>
                          {changed && !field.secret && (
                            <small className="setting-was" title={`Saved value: ${was}`}>
                              was {was}
                            </small>
                          )}
                        </div>
                        <SettingInput
                          field={field}
                          snapshot={snapshot}
                          value={value}
                          locked={disabled || !observed?.editable}
                          removing={removingPassword}
                          update={update}
                        />
                        <small id={`${controlId}-help`}>{observed?.note || field.help}</small>
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
                            disabled={disabled || !observed?.editable}
                            onClick={() => update(field.id, "", true)}
                          >
                            Clear join password
                          </button>
                        )}
                        {removingPassword && <small role="status">Join password will be removed on save.</small>}
                      </div>
                    );
                  })}
                {selected === "Rotation" && (
                  <p className="settings-link">
                    <Link to={rotationLink}>Edit maps in Match &amp; maps →</Link>
                  </p>
                )}
              </div>
            </div>
          )
        }
      </Tabs>
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
      {review && (
        <ReviewChanges
          {...review}
          close={() => setReview(null)}
          finished={(state) => {
            if (state !== "failed") setDraft(null);
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
          <tr>
            <td>Game command log</td>
            <td>—</td>
            <td>—</td>
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
