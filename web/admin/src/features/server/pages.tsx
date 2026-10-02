import { mapLabel, modeLabel } from "../../../../../src/common/map-labels";
import { useState, type CSSProperties } from "react";
import { ServerLink as Link } from "../../app/server-link";
import { useGameAdmin as useAdmin } from "../../app/context";
import { useResource } from "../../api/use-resource";
import type { Audit, Ban, Whitelist } from "../../api/types";
import { ActionButton, Badge, Card, Empty, Metric, Search, Table, date } from "../../components/ui";
import { CopyValue, DataTable } from "../../components/data-table";
import { actionDefinitions, allowed } from "../actions/policy";
import { FactionChip, liveFactions, playerFaction } from "../players/factions";
import { isPublicIndividualSteamId } from "../../../../../src/common/steam-id";
import { PlayerSheet } from "../players/player-actions";
import { EmptyRoster } from "../players/empty-roster";
import { CommunityMessages } from "./community-messages";
export function OverviewPage() {
  const { overview, me, stale, busy, openAction } = useAdmin();
  const [managedId, setManagedId] = useState<string | null>(null);
  if (!overview)
    return <Empty title="Waiting for the server" detail="Connection details will appear when the server responds." />;
  const { status, players } = overview;
  const teams = liveFactions(overview);
  const max = status.scoreCap || Math.max(1, ...status.factionScores.map((team) => team.score));
  return (
    <>
      <div className="metrics">
        <Metric
          label="PLAYERS ONLINE"
          value={
            <>
              {status.players.current}
              <small> / {status.players.max}</small>
            </>
          }
          note={stale ? "Last reported population" : "Current game population"}
        />
        <Metric
          label="CURRENT MAP"
          value={mapLabel(status.map)}
          note={status.experiences?.map((id) => modeLabel(id)).join(" · ") || "Live game"}
          word
        />
        <Metric label="YOUR ACCESS" value={me.role} note="Verified through Discord" word />
        <Metric label="SERVER STATUS" value={stale ? "Needs refresh" : "Connected"} note="RCON connection" word />
      </div>
      <div className="overview-grid">
        <Card
          title="Current match"
          subtitle={status.scoreCap ? "Faction scores" : "Scores relative to the leading faction"}
          badge={<Badge>WARDOGS</Badge>}
        >
          <div className="card-body">
            {status.factionScores.length ? (
              status.factionScores.map((team) => (
                <div className="score-row" key={team.name}>
                  <div className="score-label">
                    <span>{team.name}</span>
                    <strong>{team.score.toLocaleString()}</strong>
                  </div>
                  <progress
                    max={max}
                    value={team.score}
                    aria-label={`${team.name} score`}
                    style={
                      {
                        "--faction-color": teams.find((entry) => entry.name === team.name)?.color || undefined,
                      } as CSSProperties
                    }
                  />
                </div>
              ))
            ) : (
              <Empty title="Waiting for faction scores" />
            )}
          </div>
        </Card>
        <Card title="Quick actions" badge={<Badge>STAFF TOOLS</Badge>}>
          <div className="card-body quick-actions">
            <button
              className="quick-action"
              disabled={!allowed("broadcast", me, overview, stale, busy)}
              onClick={() => openAction("broadcast")}
            >
              <span>
                Send an announcement<small>Reach everyone currently in game</small>
              </span>
              <span>↗</span>
            </button>
            <button
              className="quick-action"
              disabled={!allowed("whitelist-add", me, overview, stale, busy)}
              onClick={() => openAction("whitelist-add")}
            >
              <span>
                Add whitelist access<small>Welcome another community member</small>
              </span>
              <span>＋</span>
            </button>
            <Link className="quick-action" to="/audit">
              <span>
                Review staff activity<small>Reasons, outcomes, and accountability</small>
              </span>
              <span>→</span>
            </Link>
          </div>
        </Card>
      </div>
      <Card
        title="On the server"
        subtitle={`${players.length} players in the current snapshot`}
        badge={
          <Link className="text-button" to="/players">
            All players →
          </Link>
        }
      >
        {players.length ? (
          <Table label="Players on this server" headers={["PLAYER", "FACTION", "K / D", "PING", ""]} scrollable>
            {players.slice(0, 6).map((player) => (
              <tr key={player.steamId}>
                <td>
                  <div className="player-name">
                    <span className="player-icon">{player.name.slice(0, 2).toUpperCase()}</span>
                    <div>
                      <strong>{player.name}</strong>
                      <small>{player.steamId}</small>
                    </div>
                  </div>
                </td>
                <td>
                  <FactionChip team={playerFaction(player, teams)} fallback={player.faction || "Choosing team"} />
                </td>
                <td>
                  {player.kills ?? "—"} / {player.deaths ?? "—"}
                </td>
                <td>{player.pingMs ?? "—"} ms</td>
                <td>
                  <button type="button" className="text-button" onClick={() => setManagedId(player.steamId)}>
                    View player →
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyRoster overview={overview} stale={stale} />
        )}
      </Card>
      {managedId && <PlayerSheet player={{ steamId: managedId }} onClose={() => setManagedId(null)} />}
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
/** Dashboard action receipts. Also shown as the Activity hub's "Action history" view. */
export function AuditPage() {
  return <DashboardHistory />;
}
export function DashboardHistory({ initialQuery = "" }: { initialQuery?: string } = {}) {
  const [query, setQuery] = useState(initialQuery);
  const lookupId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.trim())
    ? query.trim().toLowerCase()
    : "";
  const recent = useResource<Audit[]>(lookupId ? null : "audit");
  const receipt = useResource<{ record: Audit | null }>(lookupId ? `audit/${lookupId}` : null);
  const error = lookupId ? receipt.error : recent.error;
  const loading = lookupId ? receipt.loading && !receipt.data : recent.loading && !recent.data;
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
          entry.message,
          entry.details.reason,
        ].some((value) => value.toLowerCase().includes(query.trim().toLowerCase())),
      );
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
        placeholder="Search staff, SteamID, reason, or action ID"
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
              { label: "Details" },
            ]}
            renderRow={(entry) => (
              <tr key={entry.id}>
                <td>{date(entry.createdAt)}</td>
                <td>
                  <strong>{entry.actorName}</strong>
                </td>
                <td>
                  {actionDefinitions[entry.action]?.[0] || entry.action}
                  <small>{entry.target}</small>
                </td>
                <td>
                  <Badge kind={entry.state === "applied" ? "good" : entry.state === "failed" ? "bad" : "warn"}>
                    {entry.state === "started" ? "Unconfirmed" : entry.state}
                  </Badge>
                </td>
                <td className="audit-detail">
                  <strong>{entry.details.reason}</strong>
                  <br />
                  {entry.message}
                  <small>
                    <CopyValue value={entry.id} label="action ID" />
                  </small>
                </td>
              </tr>
            )}
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
    </>
  );
}
