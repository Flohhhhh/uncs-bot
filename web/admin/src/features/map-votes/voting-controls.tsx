import { useEffect, useRef, useState } from "react";
import {
  defaultVotingSettings,
  settingRangeMessage,
  votingIssues,
  votingSettingLimits,
  type DeepPartial,
  type ReminderSettings,
  type VotingContext,
  type VotingControls,
  type VotingPolicy,
  type VotingSettingLimits,
  type VotingSettings,
} from "../../../../../src/common/voting-policy";
import { useGameApi } from "../../api/server-client";
import { useResource } from "../../api/use-resource";
import { useGameAdmin } from "../../app/context";
import { errorMessage } from "../actions/policy";

/** The ballot settings this panel edits. A save sends only the ones that changed; every other setting is kept. */
type Edits = {
  optionCount: number;
  minPlayers: number;
  openDelaySeconds: number;
  openScoreCeiling: number;
  closeAtScore: number;
  midpointScore: number;
  finalScore: number;
  openInGame: boolean;
  resultInGame: boolean;
};
type NumberKey = Exclude<keyof Edits, "openInGame" | "resultInGame">;
type Draft = { version: number; policy: VotingPolicy; edits: Edits };
type Range = { min: number; max: number };

const numberFields: { key: NumberKey; label: string; range: (limits: VotingSettingLimits) => Range }[] = [
  { key: "optionCount", label: "Options per ballot", range: (limits) => limits.optionCount },
  { key: "minPlayers", label: "Minimum players", range: (limits) => limits.minPlayers },
  { key: "openDelaySeconds", label: "Opening delay (seconds)", range: (limits) => limits.openDelaySeconds },
  { key: "openScoreCeiling", label: "Opening score limit", range: (limits) => limits.openScoreCeiling },
  { key: "closeAtScore", label: "Close score", range: (limits) => limits.closeAtScore },
  { key: "midpointScore", label: "Update reminder score", range: (limits) => limits.reminderScore },
  { key: "finalScore", label: "Last-chance reminder score", range: (limits) => limits.reminderScore },
];
const switches = ["enabled", "mapChoices", "modeChoices", "midpointReminder", "finalReminder"] as const;

function editsOf(settings: VotingSettings): Edits {
  return {
    optionCount: settings.optionCount,
    minPlayers: settings.minPlayers,
    openDelaySeconds: settings.openDelaySeconds,
    openScoreCeiling: settings.openScoreCeiling,
    closeAtScore: settings.closeAtScore,
    midpointScore: settings.reminders.midpoint.score,
    finalScore: settings.reminders.final.score,
    openInGame: settings.announce.openInGame,
    resultInGame: settings.announce.resultInGame,
  };
}
function applyEdits(settings: VotingSettings, edits: Edits): VotingSettings {
  return {
    ...settings,
    optionCount: edits.optionCount,
    minPlayers: edits.minPlayers,
    openDelaySeconds: edits.openDelaySeconds,
    openScoreCeiling: edits.openScoreCeiling,
    closeAtScore: edits.closeAtScore,
    reminders: {
      midpoint: { ...settings.reminders.midpoint, score: edits.midpointScore },
      final: { ...settings.reminders.final, score: edits.finalScore },
    },
    announce: { openInGame: edits.openInGame, resultInGame: edits.resultInGame },
  };
}
/** Only the settings that differ from the saved ones, in the shape the controls save accepts; null when none do. */
function settingsPatch(saved: Edits, next: Edits): DeepPartial<VotingSettings> | null {
  const differs = (key: keyof Edits) => saved[key] !== next[key];
  const patch: DeepPartial<VotingSettings> = {
    ...(differs("optionCount") ? { optionCount: next.optionCount } : {}),
    ...(differs("minPlayers") ? { minPlayers: next.minPlayers } : {}),
    ...(differs("openDelaySeconds") ? { openDelaySeconds: next.openDelaySeconds } : {}),
    ...(differs("openScoreCeiling") ? { openScoreCeiling: next.openScoreCeiling } : {}),
    ...(differs("closeAtScore") ? { closeAtScore: next.closeAtScore } : {}),
    ...(differs("midpointScore") || differs("finalScore")
      ? {
          reminders: {
            ...(differs("midpointScore") ? { midpoint: { score: next.midpointScore } } : {}),
            ...(differs("finalScore") ? { final: { score: next.finalScore } } : {}),
          },
        }
      : {}),
    ...(differs("openInGame") || differs("resultInGame")
      ? {
          announce: {
            ...(differs("openInGame") ? { openInGame: next.openInGame } : {}),
            ...(differs("resultInGame") ? { resultInGame: next.resultInGame } : {}),
          },
        }
      : {}),
  };
  return Object.keys(patch).length ? patch : null;
}
/** The first problems a save would be refused for, worded as the backend words them. */
function draftIssues(draft: Draft, settings: VotingSettings, limits: VotingSettingLimits) {
  const ranges = numberFields.flatMap(({ key, label, range }) => {
    const value = draft.edits[key];
    const { min, max } = range(limits);
    return Number.isInteger(value) && value >= min && value <= max ? [] : [settingRangeMessage(label, { min, max })];
  });
  if (ranges.length) return ranges;
  // The switches' own rule (maps, modes or both) has its own notice below.
  return votingIssues(draft.policy, settings)
    .filter((issue) => issue.path[0] === "settings")
    .map((issue) => issue.message);
}

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
function joined(items: string[]) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
function channels(reminder: ReminderSettings) {
  if (reminder.discord && reminder.inGame) return "in Discord and in game";
  if (reminder.discord) return "in Discord only";
  return reminder.inGame ? "in game only" : "nowhere yet";
}
/** Everything Gramps will broadcast in game for an automatic ballot with these settings. */
function inGameBroadcasts(policy: VotingPolicy, settings: VotingSettings) {
  const { reminders, announce } = settings;
  return [
    announce.openInGame ? "a notice when each ballot opens" : "",
    policy.midpointReminder && reminders.midpoint.inGame ? `an update at ${reminders.midpoint.score} points` : "",
    policy.finalReminder && reminders.final.inGame ? `a last-chance reminder at ${reminders.final.score} points` : "",
    announce.resultInGame ? "the winner, a tie or no votes when each ballot ends" : "",
  ].filter(Boolean);
}

/** What the backend does with these settings, in its own numbers. */
function BallotSummary({
  policy,
  settings,
  context,
}: {
  policy: VotingPolicy;
  settings: VotingSettings;
  context?: VotingContext | null;
}) {
  const start = context?.startThreshold ?? 0;
  const players = Math.max(settings.minPlayers, start);
  const delay = settings.openDelaySeconds;
  const reminders = [
    policy.midpointReminder
      ? `an update with current totals at ${settings.reminders.midpoint.score} points ${channels(settings.reminders.midpoint)}`
      : "",
    policy.finalReminder
      ? `a last-chance reminder at ${settings.reminders.final.score} points ${channels(settings.reminders.final)}`
      : "",
  ].filter(Boolean);
  const announcements = [
    settings.announce.openInGame ? "a notice when each ballot opens" : "",
    settings.announce.resultInGame ? "the winner, a tie or no votes when each ballot ends" : "",
  ].filter(Boolean);
  return (
    <div className="ballot-summary">
      <p className="muted">
        Ballots offer up to {settings.optionCount} map/mode combinations from{" "}
        {settings.source === "pool" ? "the map pool" : "the saved rotation"}.
      </p>
      <p className="muted">
        A ballot opens once at least {players} players are online
        {start > settings.minPlayers ? ` (the game needs ${start} to start a match)` : ""},{" "}
        {delay
          ? `${delay % 60 === 0 ? plural(delay / 60, "minute") : plural(delay, "second")} into the round`
          : "as soon as the round is underway"}
        , and only while the leading team has fewer than {settings.openScoreCeiling} points.
      </p>
      <p className="muted">
        Voting closes when the leading team reaches {settings.closeAtScore} points, or from {settings.closeAtScore - 10}{" "}
        when one more scoring step could end the match. Scores count out of 100, scaled for another score cap.{" "}
        {settings.tieRule === "first_option"
          ? "A tie goes to the first tied option; no votes keeps the rotation."
          : "A tie or no votes keeps the rotation."}
      </p>
      <p className="muted">{reminders.length ? `Gramps sends ${joined(reminders)}.` : "No reminders are sent."}</p>
      <p className="muted">
        {announcements.length
          ? `In game, Gramps also broadcasts ${joined(announcements)}.`
          : "Gramps broadcasts nothing in game when a ballot opens or ends."}
      </p>
      {settings.fiftyFifty.offered && context?.fifty && <p className="muted">{context.fifty.message}</p>}
    </div>
  );
}

export function VotingControlsPanel({ onDirty }: { onDirty: (value: boolean) => void }) {
  const resource = useResource<VotingControls>("map-votes/controls");
  const api = useGameApi();
  const { busy, setBusy } = useGameAdmin();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [review, setReview] = useState(false);
  const [message, setMessage] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const saving = useRef(false);
  // A reload this panel asked for (after a save, or to recover from an uncertain one) keeps the switches locked until
  // fresh controls arrive, so a toggle cannot build on the snapshot being replaced. Background refreshes do not.
  const [reloadingFrom, setReloadingFrom] = useState<VotingControls | null>(null);
  const data = resource.data;
  const reloading = !!data && data === reloadingFrom;
  useEffect(() => {
    onDirty(!!draft);
    return () => onDirty(false);
  }, [draft, onDirty]);
  const policy = draft?.policy ?? data?.policy;
  const changed = !!draft && draft.version !== data?.version;
  // Paused until the controls are saved again: saving them unchanged resumes automatic voting.
  const paused = data?.policy?.enabled && data.paused ? data.paused : null;
  const resumable = !!paused && !draft;
  const savedSettings = data?.settings ?? defaultVotingSettings;
  const limits = data?.limits ?? votingSettingLimits;
  const savedEdits = editsOf(savedSettings);
  const edits = draft?.edits ?? savedEdits;
  const settings = draft ? applyEdits(savedSettings, draft.edits) : savedSettings;
  const issues = draft ? draftIssues(draft, settings, limits) : [];
  async function save(resume = false) {
    if (
      !data ||
      (!resume && !draft) ||
      busy ||
      saving.current ||
      changed ||
      uncertain ||
      resource.loading ||
      resource.refreshing ||
      !data.available ||
      resource.error ||
      (!resume && issues.length)
    )
      return;
    const patch = draft && !resume ? settingsPatch(savedEdits, draft.edits) : null;
    const request =
      resume || !draft
        ? { version: data.version, policy: data.policy }
        : { version: draft.version, policy: draft.policy, ...(patch ? { settings: patch } : {}) };
    if (request.policy.enabled && !data.policy.enabled && !review) {
      setReview(true);
      return;
    }
    saving.current = true;
    setBusy(true);
    setMessage("");
    try {
      await api<VotingControls>("map-votes/controls", {
        method: "POST",
        body: JSON.stringify({ serverId: data.serverId, ...request }),
      });
      setDraft(null);
      setReview(false);
      setMessage(resume ? "Voting controls saved unchanged. Automatic voting resumes." : "Voting controls saved.");
      setReloadingFrom(data);
      resource.refresh();
    } catch (error) {
      setMessage(`${errorMessage(error)} Reload the saved controls before trying again.`);
      setUncertain(true);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  if (!data || !policy)
    return resource.error ? (
      <div className="notice error" role="alert">
        <p>{resource.error}</p>
        <button
          type="button"
          className="button secondary"
          disabled={busy || resource.loading || resource.refreshing}
          onClick={resource.refresh}
        >
          Reload saved controls
        </button>
      </div>
    ) : (
      <p role="status">Loading voting controls…</p>
    );
  function change(next: { policy?: VotingPolicy; edits?: Edits }) {
    if (!data || !policy) return;
    setReview(false);
    const nextPolicy = next.policy ?? policy;
    const nextEdits = next.edits ?? edits;
    const unchanged =
      switches.every((key) => nextPolicy[key] === data.policy[key]) && !settingsPatch(savedEdits, nextEdits);
    setDraft(unchanged ? null : { version: draft?.version ?? data.version, policy: nextPolicy, edits: nextEdits });
  }
  const toggles: { key: keyof VotingPolicy; label: string }[] = [
    { key: "enabled", label: "Automatic community voting" },
    { key: "mapChoices", label: "Offer different maps" },
    { key: "modeChoices", label: "Offer different game modes" },
    { key: "midpointReminder", label: `Score ${edits.midpointScore} update · current vote totals` },
    { key: "finalReminder", label: `Score ${edits.finalScore} reminder · last chance to vote` },
  ];
  const locked = busy || resource.loading || reloading || !data.available || changed || !!resource.error || uncertain;
  const broadcasts = inGameBroadcasts(policy, settings);
  return (
    <>
      <p className="muted">{data.message}</p>
      <fieldset className="mode-choices" disabled={locked}>
        <legend>Community voting</legend>
        {toggles.map(({ key, label }) => (
          <label className="checkbox-label" key={key}>
            <input
              type="checkbox"
              checked={policy[key]}
              disabled={key === "enabled" && !data.ready && !policy.enabled}
              onChange={(event) => change({ policy: { ...policy, [key]: event.target.checked } })}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {data.settings && (
        <fieldset className="mode-choices ballot-settings" disabled={locked}>
          <legend>Ballot settings</legend>
          <div className="settings-grid ballot-fields">
            {numberFields.map(({ key, label, range }) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={range(limits).min}
                  max={range(limits).max}
                  step={1}
                  value={edits[key]}
                  onChange={(event) => change({ edits: { ...edits, [key]: Number(event.target.value) } })}
                />
              </label>
            ))}
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={edits.openInGame}
              onChange={(event) => change({ edits: { ...edits, openInGame: event.target.checked } })}
            />
            Announce each ballot in game when it opens
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={edits.resultInGame}
              onChange={(event) => change({ edits: { ...edits, resultInGame: event.target.checked } })}
            />
            Announce the result in game when a ballot ends
          </label>
        </fieldset>
      )}
      <BallotSummary policy={policy} settings={settings} context={data.context} />
      {changed && (
        <p className="notice warning" role="alert">
          Another administrator changed these controls. Reload before saving.
        </p>
      )}
      {policy.enabled && !policy.mapChoices && !policy.modeChoices && (
        <p role="alert">Offer maps, modes, or both before enabling voting.</p>
      )}
      {issues.length > 0 && (
        <div className="notice warning" role="alert">
          {issues.map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
        </div>
      )}
      {resource.error && <p role="alert">{resource.error}</p>}
      {review && (
        <p className="notice warning" role="alert">
          Enable automatic voting for this server? Gramps will post ballots and queue community winners for the next
          round.{" "}
          {broadcasts.length
            ? `In game, it will also broadcast ${joined(broadcasts)}.`
            : "It will not broadcast anything in game."}
        </p>
      )}
      {paused && (
        <div className="notice warning" role="alert">
          <p>Automatic voting is paused. {paused}</p>
          {!draft && (
            <p>
              Save to resume keeps every switch and setting as it is. Gramps then acts for you as the administrator
              responsible for automatic voting.
            </p>
          )}
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {(draft || uncertain || resource.error || resumable) && (
        <div className="dialog-actions">
          {resumable && (
            <button
              className="button primary"
              disabled={
                busy ||
                resource.loading ||
                resource.refreshing ||
                reloading ||
                !data.available ||
                uncertain ||
                !!resource.error
              }
              onClick={() => void save(true)}
            >
              Save to resume
            </button>
          )}
          {draft && (
            <button
              className="button primary"
              disabled={
                busy ||
                resource.loading ||
                resource.refreshing ||
                !data.available ||
                changed ||
                uncertain ||
                !!resource.error ||
                issues.length > 0 ||
                (policy.enabled && !policy.mapChoices && !policy.modeChoices)
              }
              onClick={() => void save()}
            >
              {review ? "Confirm enable voting" : "Save voting controls"}
            </button>
          )}
          <button
            className="button secondary"
            disabled={busy || resource.loading || resource.refreshing}
            onClick={() => {
              setDraft(null);
              setReview(false);
              setUncertain(false);
              setMessage("");
              setReloadingFrom(data);
              resource.refresh();
            }}
          >
            Reload saved controls
          </button>
        </div>
      )}
    </>
  );
}
