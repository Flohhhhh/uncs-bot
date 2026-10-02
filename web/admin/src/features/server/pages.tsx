import { lightingLabel, mapLabel, modeLabel, zoneLabel } from "../../../../../src/common/map-labels";
import { roundStamp } from "../../../../../src/common/game-round";
import type { SettingsSnapshot } from "../../../../../src/common/server-settings";
import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { ServerLink as Link } from "../../app/server-link";
import { useGameAdmin as useAdmin } from "../../app/context";
import { useResource } from "../../api/use-resource";
import type { Audit, Ban, Whitelist } from "../../api/types";
import { ActionButton, Badge, Card, Empty, OutcomeBadge, Search, date } from "../../components/ui";
import { CopyValue, DataTable, compareValues } from "../../components/data-table";
import { actionDefinitions, allowed } from "../actions/policy";
import { FactionChip, liveFactions, playerFaction } from "../players/factions";
import { isPublicIndividualSteamId } from "../../../../../src/common/steam-id";
import { PlayerButton, PlayerSheet, type SheetPlayer } from "../players/player-actions";
import { EmptyRoster } from "../players/empty-roster";
import { nextRoundSummary } from "./next-round";
import { ActivityLine, When, useActivityEntries } from "./activity-entries";
import { CommunityMessages } from "./community-messages";

/** Only the fields the Overview reads from the voting status. */
type VoteSummary = { enabled?: boolean; votes?: { state?: string; closesAt?: string; automation?: unknown }[] };
const voteStates: Record<string, string> = {
  publishing: "Creating ballot",
  closing: "Counting votes",
  needs_review: "Needs review",
};
const clockTime = (value: string | number) =>
  new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
function elapsed(seconds: number) {
  const total = Math.floor(seconds);
  const pad = (value: number) => String(value).padStart(2, "0");
  const minutes = Math.floor(total / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(total % 60)}`
    : `${minutes}:${pad(total % 60)}`;
}
function NowItem({ label, value, note, title }: { label: string; value: ReactNode; note?: ReactNode; title?: string }) {
  return (
    <div className="now-item" title={title}>
      <span className="now-label">{label}</span>
      <strong className="now-value">{value}</strong>
      {note && <span className="now-note">{note}</span>}
    </div>
  );
}

export function OverviewPage() {
  const { overview, me, stale, busy, openAction } = useAdmin();
  const isAdmin = me.role === "admin";
  const settings = useResource<SettingsSnapshot>(isAdmin ? "settings" : null);
  const voting = useResource<VoteSummary>(isAdmin ? "map-votes" : null);
  const activity = useActivityEntries(false);
  const [managed, setManaged] = useState<SheetPlayer | null>(null);
  if (!overview)
    return <Empty title="Waiting for the server" detail="Connection details will appear when the server responds." />;
  const { status, players } = overview;
  const teams = liveFactions(overview);
  const max = status.scoreCap || Math.max(1, ...status.factionScores.map((team) => team.score));
  const stamp = roundStamp(status, Date.parse(overview.observedAt));
  const setup = [
    ...(status.experiences ?? []).map((id) => modeLabel(id)),
    status.alternator && status.alternator !== "None" ? zoneLabel(status.alternator) : "",
    status.lighting ? lightingLabel(status.lighting).replaceAll(" · ", " ") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // A malformed read counts as unavailable, never as a confirmed next round.
  const snapshot =
    settings.data && typeof settings.data === "object" && "rotation" in settings.data && settings.data.rotation
      ? settings.data
      : null;
  const next = nextRoundSummary(snapshot);
  const votes = voting.data && Array.isArray(voting.data.votes) ? voting.data : null;
  const vote = votes?.votes?.find((item) =>
    ["publishing", "open", "closing", "needs_review"].includes(item.state ?? ""),
  );
  const top = [...players].sort((a, b) => compareValues(a.kills, b.kills, "descending")).slice(0, 8);
  const recent = activity.entries.filter((entry) => entry.category !== "combat").slice(0, 6);
  return (
    <>
      <div className="overview-actions">
        <button
          type="button"
          className="button primary small"
          disabled={!allowed("broadcast", me, overview, stale, busy)}
          onClick={() => openAction("broadcast")}
        >
          Send an announcement
        </button>
        <button
          type="button"
          className="button secondary small"
          disabled={!allowed("whitelist-add", me, overview, stale, busy)}
          onClick={() => openAction("whitelist-add")}
        >
          Add to whitelist
        </button>
      </div>
      <section className="now-band" aria-label="Now">
        <NowItem
          label="Players"
          value={
            <>
              {status.players.current}
              <small> / {status.players.max}</small>
            </>
          }
          note={
            teams.length > 0 && (
              <span className="team-split">
                {teams.map((team) => (
                  <span key={team.name} title={team.label}>
                    {team.color ? (
                      <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
                        <circle cx="5" cy="5" r="5" fill={team.color} />
                      </svg>
                    ) : (
                      `${team.name} `
                    )}
                    <span className="sr-only">{team.label}: </span>
                    {players.filter((player) => playerFaction(player, teams)?.name === team.name).length}
                  </span>
                ))}
              </span>
            )
          }
        />
        <NowItem label="Map" value={mapLabel(status.map)} note={setup || "Mode not reported"} />
        <NowItem
          label="Round"
          value={stamp ? `${elapsed(status.matchSeconds ?? 0)} elapsed` : "No clock"}
          note={
            stamp
              ? `${stale ? "last checked" : "checked"} ${clockTime(overview.observedAt)}`
              : "Not reported by the game"
          }
        />
        {isAdmin && (
          <NowItem
            label="Next round"
            value={snapshot ? next.label : settings.loading && !settings.error ? "Checking…" : "Unavailable"}
            note={
              !snapshot
                ? settings.error && "Settings could not be read"
                : next.state === "saved"
                  ? "Saved next round"
                  : next.state === "game-next"
                    ? "Next in the game’s rotation"
                    : undefined
            }
            title={next.note || undefined}
          />
        )}
        {isAdmin && (
          <NowItem
            label="Vote"
            value={
              !votes
                ? voting.loading && !voting.error
                  ? "Checking…"
                  : "Unavailable"
                : !votes.enabled
                  ? "Off"
                  : !vote
                    ? "None"
                    : vote.state === "open"
                      ? vote.automation || !vote.closesAt
                        ? "Open"
                        : `Open · ends ${clockTime(vote.closesAt)}`
                      : voteStates[vote.state ?? ""]
            }
            note={vote?.state === "open" && vote.automation ? "Closes automatically" : undefined}
          />
        )}
        <Link className="text-button now-link" to="/match">
          Match &amp; maps →
        </Link>
      </section>
      <div className="overview-grid">
        <Card
          className="overview-scores"
          title="Scores"
          subtitle={status.scoreCap ? `First to ${status.scoreCap.toLocaleString()}` : "Relative to the leading team"}
        >
          <div className="card-body">
            {status.factionScores.length ? (
              status.factionScores.map((team) => {
                const faction = teams.find((entry) => entry.name === team.name);
                return (
                  <div className="score-row" key={team.name}>
                    <div className="score-label">
                      <FactionChip team={faction} fallback={team.name} />
                      <strong>{team.score.toLocaleString()}</strong>
                    </div>
                    <progress
                      max={max}
                      value={team.score}
                      aria-label={`${team.name} score`}
                      style={{ "--faction-color": faction?.color || undefined } as CSSProperties}
                    />
                  </div>
                );
              })
            ) : (
              <p className="muted">Waiting for team scores.</p>
            )}
          </div>
        </Card>
        <Card
          className="overview-players"
          title="Players"
          subtitle={players.length > top.length ? `Top ${top.length} by kills` : "By kills"}
          badge={
            <Link className="text-button" to="/players">
              Manage {players.length} →
            </Link>
          }
        >
          {players.length ? (
            <ul className="overview-roster" aria-label="Players on this server">
              {top.map((player) => (
                <li key={player.steamId}>
                  <span className="overview-roster-name">
                    <PlayerButton player={player} onOpen={setManaged} />
                    <FactionChip team={playerFaction(player, teams)} fallback={player.faction || "Choosing team"} />
                  </span>
                  <span className="overview-roster-kd">
                    <span className="sr-only">Kills / deaths </span>
                    {player.kills ?? "—"} / {player.deaths ?? "—"}
                  </span>
                  <span className="muted">{player.pingMs ?? "—"} ms</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyRoster overview={overview} stale={stale} />
          )}
        </Card>
        <Card
          className="overview-activity"
          title="Recent activity"
          badge={
            <Link className="text-button" to="/activity">
              All activity →
            </Link>
          }
        >
          {recent.length ? (
            <ol className="overview-feed">
              {recent.map((entry) => (
                <li key={entry.id}>
                  <When at={entry.at} />
                  <ActivityLine entry={entry} onPlayer={setManaged} />
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted card-body">
              {activity.loading
                ? "Loading recent activity…"
                : activity.failed.length
                  ? "Recent activity could not be loaded."
                  : "No recent activity yet."}
            </p>
          )}
        </Card>
      </div>
      {managed && <PlayerSheet player={managed} onClose={() => setManaged(null)} />}
    </>
  );
}
export function WhitelistPage() {
  const { data, error } = useResource<Whitelist>("whitelist");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  if (!data)
    return <Empty title={error ? "Whitelist could not be loaded" : "Loading whitelist…"} detail={error || ""} />;
  const invalidIds = [
    data.invalidEntryCount > 0 ? `${data.invalidEntryCount} in the running game` : "",
    (data.configuredInvalidEntryCount ?? 0) > 0 ? `${data.configuredInvalidEntryCount} in saved configuration` : "",
  ].filter(Boolean);
  const rows = data.entries.filter(
    (entry) =>
      entry.steamId.includes(query.trim()) &&
      (!filter ||
        (filter === "active" && entry.active) ||
        (filter === "pending" && entry.configured !== null && entry.configured !== entry.active) ||
        (filter === "unknown" && entry.configured === null)),
  );
  return (
    <>
      {error && (
        <div className="notice error" role="alert">
          {error} Showing the last successful list.
        </div>
      )}
      {invalidIds.length > 0 && (
        <div className="notice warning" role="status">
          <strong>Invalid SteamIDs: {invalidIds.join("; ")}.</strong> Valid entries are shown. Fix invalid IDs in the
          host panel; edits here preserve them.
        </div>
      )}
      {!data.configurationAvailable && (
        <div className="notice warning">
          The running whitelist is available, but the saved configuration could not be checked.
        </div>
      )}
      <Search value={query} onChange={setQuery} placeholder="Search SteamID64">
        <select aria-label="Whitelist status" value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="">All entries</option>
          <option value="active">Active in game</option>
          <option value="pending">Pending changes</option>
          <option value="unknown">Configuration unavailable</option>
        </select>
        {filter && (
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setFilter("");
              setQuery("");
            }}
          >
            Reset filters
          </button>
        )}
        <ActionButton action="whitelist-add" kind="primary" disabled={!!error}>
          + Add player
        </ActionButton>
      </Search>
      <Card
        title={`${data.entries.filter((entry) => entry.active).length} active entries`}
        subtitle={`${rows.length} shown of ${data.entries.length} entries`}
        badge={<Badge>SERVER WHITELIST</Badge>}
      >
        {rows.length ? (
          <DataTable
            label="Community whitelist"
            rows={rows}
            columns={[
              { label: "SteamID64", value: (entry) => entry.steamId },
              { label: "Running game", value: (entry) => entry.active },
              { label: "Saved configuration", value: (entry) => entry.configured },
              { label: "Actions" },
            ]}
            renderRow={(entry) => (
              <tr key={entry.steamId}>
                <td>
                  <strong>
                    <CopyValue value={entry.steamId} />
                  </strong>
                </td>
                <td>
                  <Badge kind={entry.active ? "good" : "warn"}>{entry.active ? "Active" : "Not active"}</Badge>
                </td>
                <td>
                  <Badge kind={entry.configured === entry.active ? "neutral" : "warn"}>
                    {entry.configured === null
                      ? "Unavailable"
                      : entry.configured
                        ? entry.active
                          ? "Saved"
                          : "Addition pending"
                        : entry.active
                          ? "Removal pending"
                          : "Removed"}
                  </Badge>
                </td>
                <td>
                  <ActionButton
                    action="whitelist-remove"
                    steamId={entry.steamId}
                    kind="danger small"
                    disabled={!!error}
                  >
                    Remove
                  </ActionButton>
                </td>
              </tr>
            )}
          />
        ) : (
          <Empty title={query.trim() || filter ? "No matching entries" : "No player entries available"} />
        )}
      </Card>
    </>
  );
}
export function BansPage() {
  const { data, error } = useResource<Ban[]>("bans");
  const [query, setQuery] = useState("");
  if (!data) return <Empty title={error ? "Bans could not be loaded" : "Loading bans…"} detail={error} />;
  const invalidCount = data.filter((ban) => !isPublicIndividualSteamId(ban.steamId)).length;
  const rows = data.filter((ban) =>
    [ban.steamId, ban.reason, ban.bannedBy].some((value) => value?.toLowerCase().includes(query.trim().toLowerCase())),
  );
  return (
    <>
      {error && (
        <div className="notice error" role="alert">
          {error} Showing the last successful list.
        </div>
      )}
      {invalidCount > 0 && (
        <div className="notice warning" role="status">
          {invalidCount} ban {invalidCount === 1 ? "entry has an invalid SteamID" : "entries have invalid SteamIDs"}.{" "}
          All entries are shown. Review invalid IDs in the host panel; they cannot be changed here.
        </div>
      )}
      <Search value={query} onChange={setQuery} placeholder="Search SteamID or reason">
        <ActionButton action="ban" kind="danger" disabled={!!error}>
          + Ban player
        </ActionButton>
      </Search>
      <Card
        title={`${data.length} server bans`}
        subtitle={`${rows.length} shown`}
        badge={<Badge>PERMANENT UNTIL REMOVED</Badge>}
      >
        {rows.length ? (
          <DataTable
            label="Server bans"
            rows={rows}
            columns={[
              { label: "SteamID64", value: (ban) => ban.steamId },
              {
                label: "Banned",
                value: (ban) =>
                  ban.bannedAtUtc && !ban.bannedAtUtc.startsWith("0001") ? Date.parse(ban.bannedAtUtc) : null,
                firstDirection: "descending",
              },
              { label: "Reason", value: (ban) => ban.reason },
              { label: "Banned by", value: (ban) => ban.bannedBy },
              { label: "Actions" },
            ]}
            renderRow={(ban) => (
              <tr key={ban.steamId}>
                <td>
                  <strong>
                    <CopyValue value={ban.steamId} />
                  </strong>
                  {!isPublicIndividualSteamId(ban.steamId) && <Badge kind="warning">Invalid SteamID</Badge>}
                </td>
                <td>
                  {ban.bannedAtUtc && !ban.bannedAtUtc.startsWith("0001") ? date(ban.bannedAtUtc) : "Date not provided"}
                </td>
                <td className="audit-detail">{ban.reason || "No reason supplied by the game"}</td>
                <td>{ban.bannedBy || "—"}</td>
                <td>
                  <ActionButton
                    action="unban"
                    steamId={ban.steamId}
                    disabled={!!error || !isPublicIndividualSteamId(ban.steamId)}
                  >
                    Remove ban
                  </ActionButton>
                </td>
              </tr>
            )}
          />
        ) : (
          <Empty title={query.trim() ? "No matching bans" : "No server bans recorded"} />
        )}
      </Card>
    </>
  );
}
export function AnnouncementsPage() {
  return (
    <div className="split">
      <Card title="In-game broadcast" badge={<Badge kind="good">SEND NOW</Badge>}>
        <div className="card-body">
          <p className="intro">
            An announcement for everyone currently connected. Use it for server notices, community events, or a quick
            thank-you.
          </p>
          <div className="copy-example">
            GG! Get whitelisted at theuncsgaming.com/whitelist. Thanks for playing on The UNCs.
          </div>
          <ActionButton action="broadcast" kind="primary">
            Write announcement ↗
          </ActionButton>
        </div>
      </Card>
      <CommunityMessages />
    </div>
  );
}
/** A complete action ID. Anything shorter stays a search of the recent actions. */
export const actionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The message text an announcement or player message carried, when the receipt has it. */
function sentMessage(entry: Audit) {
  const value = (entry.details as Record<string, unknown> | null | undefined)?.message;
  return typeof value === "string" ? value.trim() : "";
}
/** Dashboard action receipts. Also shown as the Activity hub's "Action history" view. */
export function AuditPage() {
  return <DashboardHistory />;
}
export function DashboardHistory({ initialQuery = "" }: { initialQuery?: string } = {}) {
  const { overview } = useAdmin();
  const [query, setQuery] = useState(initialQuery);
  // Rows whose details differ from the default: closed in recent history, open for an exact lookup.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const [managed, setManaged] = useState<SheetPlayer | null>(null);
  const lookupId = actionIdPattern.test(query.trim()) ? query.trim().toLowerCase() : "";
  const recent = useResource<Audit[]>(lookupId ? null : "audit");
  const receipt = useResource<{ record: Audit | null }>(lookupId ? `audit/${lookupId}` : null);
  const error = lookupId ? receipt.error : recent.error;
  const loading = lookupId ? receipt.loading && !receipt.data : recent.loading && !recent.data;
  // Receipts store the SteamID only; names come from the latest roster this page has seen.
  const nameOf = (target: string) => overview?.players.find((player) => player.steamId === target)?.name ?? "";
  const search = query.trim().toLowerCase();
  const rows = lookupId
    ? receipt.data?.record
      ? [receipt.data.record]
      : []
    : (recent.data ?? []).filter((entry) =>
        [
          entry.id,
          entry.actorName,
          entry.action,
          actionDefinitions[entry.action]?.[0] || "",
          entry.target,
          nameOf(entry.target),
          entry.message,
          entry.details?.reason,
        ].some((value) => (value ?? "").toLowerCase().includes(search)),
      );
  const toggle = (id: string) =>
    setToggled((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <>
      {error && (
        <div className="notice error" role="alert">
          {error}
          {rows.length > 0 && " Showing the last successful result."}
        </div>
      )}
      <Search
        value={query}
        onChange={setQuery}
        placeholder="Search staff, player, SteamID, reason, or action ID"
        clearLabel={lookupId ? "Back to recent actions" : "Clear search"}
      />
      <p className="filter-note">
        {lookupId
          ? "Exact action ID lookup across stored history. This only reads the receipt; it does not resend the action or recheck the game."
          : "Search the latest 100 actions, or paste a complete action ID to retrieve an older receipt."}
      </p>
      <Card
        title={lookupId ? "Action receipt" : "Recent dashboard actions"}
        badge={<Badge>{lookupId ? "EXACT ID" : "LAST 100"}</Badge>}
      >
        {loading ? (
          <Empty title={lookupId ? "Looking up action receipt…" : "Loading action history…"} />
        ) : rows.length ? (
          <DataTable
            label="Staff action history"
            rows={rows}
            columns={[
              { label: "When", value: (entry) => Date.parse(entry.createdAt), firstDirection: "descending" },
              { label: "Staff", value: (entry) => entry.actorName },
              { label: "Action / target", value: (entry) => actionDefinitions[entry.action]?.[0] || entry.action },
              { label: "Outcome", value: (entry) => entry.state },
              { label: "Reason & result" },
              { label: "" },
            ]}
            renderRow={(entry) => {
              const open = lookupId ? !toggled.has(entry.id) : toggled.has(entry.id);
              const player = isPublicIndividualSteamId(entry.target) ? entry.target : "";
              const name = player ? nameOf(player) : "";
              const message = sentMessage(entry);
              return (
                <Fragment key={entry.id}>
                  <tr>
                    <td className="audit-when">
                      <When at={entry.createdAt} />
                    </td>
                    <td>
                      <strong>{entry.actorName}</strong>
                    </td>
                    <td className="audit-action">
                      {actionDefinitions[entry.action]?.[0] || entry.action}
                      {player ? (
                        <span className="audit-target">
                          <PlayerButton player={{ steamId: player, name: name || undefined }} onOpen={setManaged} />
                          {name && <small>{player}</small>}
                        </span>
                      ) : (
                        entry.target !== "server" && <small>{entry.target}</small>
                      )}
                    </td>
                    <td>
                      <OutcomeBadge state={entry.state} />
                    </td>
                    <td className="audit-detail">
                      {entry.details?.reason && <strong>{entry.details.reason}</strong>}
                      {entry.message && <span>{entry.message}</span>}
                    </td>
                    <td className="audit-toggle">
                      <button
                        type="button"
                        className="text-button"
                        aria-expanded={open}
                        aria-controls={`receipt-${entry.id}`}
                        onClick={() => toggle(entry.id)}
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                  <tr id={`receipt-${entry.id}`} className="audit-more" hidden={!open}>
                    <td colSpan={6}>
                      <dl>
                        <div>
                          <dt>Action ID</dt>
                          <dd>
                            <CopyValue value={entry.id} label="action ID" />
                          </dd>
                        </div>
                        {message && (
                          <div>
                            <dt>Message sent</dt>
                            <dd>{message}</dd>
                          </div>
                        )}
                      </dl>
                    </td>
                  </tr>
                </Fragment>
              );
            }}
          />
        ) : error ? (
          <Empty
            title={lookupId ? "Action receipt could not be loaded" : "Action history could not be loaded"}
            detail="Refresh to try this read again. No game action was sent."
          />
        ) : lookupId ? (
          <Empty
            title="No stored receipt for this action ID"
            detail="This does not establish whether the game acted. Check the game before repeating an uncertain request."
          />
        ) : (
          <Empty
            title={query.trim() ? "No matching staff actions" : "No recorded staff actions"}
            detail="Actions performed through this dashboard appear here. Older activity from other tools is not imported."
          />
        )}
      </Card>
      {managed && <PlayerSheet player={managed} onClose={() => setManaged(null)} />}
    </>
  );
}
