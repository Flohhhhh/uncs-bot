import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAdmin } from "../../app/context";
import { useResource } from "../../api/use-resource";
import type { ActionName, Audit, Ban, Rotation, Whitelist } from "../../api/types";
import { Badge, Card, Empty, Metric, Search, Table, date } from "../../components/ui";
import { actionDefinitions, allowed } from "../actions/policy";
import { FactionChip, liveFactions, playerFaction } from "../players/factions";
function ActionButton({
  action,
  steamId,
  children,
  kind = "secondary small",
  disabled = false,
}: {
  action: ActionName;
  steamId?: string;
  children: ReactNode;
  kind?: string;
  disabled?: boolean;
}) {
  const { me, overview, stale, busy, openAction } = useAdmin();
  return (
    <button
      className={`button ${kind}`}
      disabled={disabled || !allowed(action, me, overview, stale, busy)}
      onClick={() => openAction(action, steamId)}
    >
      {children}
    </button>
  );
}
export function OverviewPage() {
  const { overview, me, stale, busy, openAction } = useAdmin();
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
          note="Current game population"
        />
        <Metric label="CURRENT MAP" value={status.map} note={status.experiences?.join(" · ") || "Live game"} word />
        <Metric label="YOUR ACCESS" value={me.role} note="Verified through Discord" word />
        <Metric label="SERVER STATUS" value={stale ? "Unavailable" : "Connected"} note="RCON connection" word />
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
                  <progress max={max} value={team.score} aria-label={`${team.name} score`} />
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
          <Table headers={["PLAYER", "FACTION", "K / D", "PING", ""]}>
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
                  <Link className="text-button" to="/players">
                    View player →
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty title="The server is quiet" detail="Players will appear here as they join." />
        )}
      </Card>
    </>
  );
}
export function WhitelistPage() {
  const { data, error } = useResource<Whitelist>("whitelist");
  const [query, setQuery] = useState("");
  if (!data)
    return <Empty title={error ? "Whitelist could not be loaded" : "Loading whitelist…"} detail={error || ""} />;
  const rows = data.entries.filter((entry) => entry.steamId.includes(query.trim()));
  return (
    <>
      {error && (
        <div className="notice error" role="alert">
          {error} Showing the last successful list.
        </div>
      )}
      <div className="notice info">
        <strong>Current community access stays in place.</strong> Existing whitelist entries have no new expiry.
        Membership billing, seeding rewards, and future queue tiers are not changing this list.
      </div>
      {data.invalidEntryCount > 0 && (
        <div className="notice warning">
          <strong>{data.invalidEntryCount} malformed reserved-slot entries.</strong> Valid SteamIDs are shown below.
          Review malformed entries in the server configuration; this view does not change the server list.
        </div>
      )}
      {!data.configurationAvailable && (
        <div className="notice warning">
          The running whitelist is available, but the saved configuration could not be checked.
        </div>
      )}
      <Search value={query} onChange={setQuery} placeholder="Search SteamID64">
        <ActionButton action="whitelist-add" kind="primary" disabled={!!error}>
          + Add player
        </ActionButton>
      </Search>
      <Card
        title={`${data.entries.filter((entry) => entry.active).length} active entries`}
        badge={<Badge>SERVER WHITELIST</Badge>}
      >
        {rows.length ? (
          <Table headers={["STEAMID64", "RUNNING GAME", "SAVED CONFIGURATION", ""]}>
            {rows.map((entry) => (
              <tr key={entry.steamId}>
                <td>
                  <strong>{entry.steamId}</strong>
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
            ))}
          </Table>
        ) : (
          <Empty title="No matching entries" />
        )}
      </Card>
    </>
  );
}
export function BansPage() {
  const { data, error } = useResource<Ban[]>("bans");
  const [query, setQuery] = useState("");
  if (!data) return <Empty title={error ? "Bans could not be loaded" : "Loading bans…"} detail={error} />;
  const rows = data.filter((ban) =>
    [ban.steamId, ban.reason, ban.bannedBy].some((value) => value?.toLowerCase().includes(query.toLowerCase())),
  );
  return (
    <>
      {error && (
        <div className="notice error" role="alert">
          {error} Showing the last successful list.
        </div>
      )}
      <Search value={query} onChange={setQuery} placeholder="Search SteamID or reason">
        <ActionButton action="ban" kind="danger" disabled={!!error}>
          + Ban player
        </ActionButton>
      </Search>
      <Card title={`${data.length} server bans`} badge={<Badge>PERMANENT UNTIL REMOVED</Badge>}>
        {rows.length ? (
          <Table headers={["PLAYER", "REASON", "BANNED BY", ""]}>
            {rows.map((ban) => (
              <tr key={ban.steamId}>
                <td>
                  <strong>{ban.steamId}</strong>
                  <small>
                    {ban.bannedAtUtc && !ban.bannedAtUtc.startsWith("0001")
                      ? date(ban.bannedAtUtc)
                      : "Date not provided"}
                  </small>
                </td>
                <td className="audit-detail">{ban.reason || "No reason supplied by the game"}</td>
                <td>{ban.bannedBy || "—"}</td>
                <td>
                  <ActionButton action="unban" steamId={ban.steamId} disabled={!!error}>
                    Remove ban
                  </ActionButton>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty title="No matching bans" />
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
            GG! Thanks for playing on The UNCs. Squad up with our adult gaming community at discord.gg/t5NSzurtRS.
          </div>
          <ActionButton action="broadcast" kind="primary">
            Write announcement ↗
          </ActionButton>
        </div>
      </Card>
      <Card title="Automatic community messages" badge={<Badge>SEPARATE CONFIGURATION</Badge>}>
        <div className="card-body">
          <p className="intro">
            Join welcomes, automatic end-of-match messages, and the Discord live-status card are configured separately
            in Gramps. This page does not report or change their activation state.
          </p>
          <div className="info-row">
            <span>Join welcome</span>
            <strong>Gramps automation</strong>
          </div>
          <div className="info-row">
            <span>End-of-match automation</span>
            <strong>Gramps automation</strong>
          </div>
          <div className="info-row">
            <span>Discord status card</span>
            <strong>Gramps automation</strong>
          </div>
        </div>
      </Card>
    </div>
  );
}
export function MatchPage() {
  const { overview, me } = useAdmin();
  const { data: rotation, error } = useResource<Rotation>("rotation");
  if (!overview) return <Empty title="Waiting for the server" />;
  const { status } = overview;
  return (
    <>
      <div className="split">
        <Card title="Current match" badge={<Badge>{status.map}</Badge>}>
          <div className="card-body">
            <div className="info-row">
              <span>Map</span>
              <strong>{status.map}</strong>
            </div>
            <div className="info-row">
              <span>Lighting</span>
              <strong>{status.lighting || "Not supplied"}</strong>
            </div>
            <div className="info-row">
              <span>Experience</span>
              <strong>{status.experiences?.join(", ") || "Not supplied"}</strong>
            </div>
            <p className="intro">
              Map and match actions affect everyone in the game. Confirm the exact action before sending it to the
              server.
            </p>
            <div className="action-list">
              <ActionButton action="map">Change map</ActionButton>
              <ActionButton action="lighting">Set lighting</ActionButton>
              <ActionButton action="match-end" kind="danger small">
                End match
              </ActionButton>
              <ActionButton action="match-restart" kind="danger small">
                Restart match
              </ActionButton>
            </div>
          </div>
        </Card>
        <Card title="Map rotation" badge={<Badge>{error ? "UNAVAILABLE" : rotation?.mode || "LOADING"}</Badge>}>
          {me.role === "admin" && (
            <div className="card-body">
              <Link className="button secondary" to="/settings">
                Edit rotation & queue next map →
              </Link>
            </div>
          )}
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          {rotation ? (
            <Table headers={["MAP", "LIGHTING", "STATUS"]}>
              {rotation.entries.map((entry) => (
                <tr key={entry.index}>
                  <td>{entry.map}</td>
                  <td>{entry.lighting || "—"}</td>
                  <td>
                    <Badge kind={entry.status === "now" ? "good" : "neutral"}>
                      {entry.denied ? "Unavailable" : entry.status || "Queued"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty title="Rotation is unavailable" detail="The current game build may not expose it." />
          )}
        </Card>
      </div>
      <div className="notice info">
        Server process restarts, host scheduling, and configuration outside the game remain in the hosting panel.
        “Restart match” only reloads the current round.
      </div>
    </>
  );
}
export function AuditPage() {
  const [query, setQuery] = useState("");
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
        ].some((value) => value.toLowerCase().includes(query.toLowerCase())),
      );
  return (
    <>
      {error && (
        <div className="notice error" role="alert">
          {error}
          {rows.length > 0 && " Showing the last successful result."}
        </div>
      )}
      <Search value={query} onChange={setQuery} placeholder="Search staff, SteamID, reason, or action ID">
        {lookupId && (
          <button type="button" className="button secondary" onClick={() => setQuery("")}>
            Back to recent actions
          </button>
        )}
      </Search>
      <p className="filter-note">
        {lookupId
          ? "Exact action ID lookup across stored history. This only reads the receipt; it does not resend the action or recheck the game."
          : "Search the latest 100 actions, or paste a complete action ID to retrieve an older receipt."}
      </p>
      <Card
        title={lookupId ? "Action receipt" : "Recent staff actions"}
        badge={<Badge>{lookupId ? "EXACT ID" : "LAST 100"}</Badge>}
      >
        {loading ? (
          <Empty title={lookupId ? "Looking up action receipt…" : "Loading action history…"} />
        ) : rows.length ? (
          <Table headers={["WHEN / STAFF", "ACTION / TARGET", "OUTCOME", "DETAILS"]}>
            {rows.map((entry) => (
              <tr key={entry.id}>
                <td>
                  <strong>{entry.actorName}</strong>
                  <small>{date(entry.createdAt)}</small>
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
                  <small>{entry.id}</small>
                </td>
              </tr>
            ))}
          </Table>
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
            title="No matching staff actions"
            detail="Actions performed through this dashboard appear here. Older activity from other tools is not imported."
          />
        )}
      </Card>
    </>
  );
}
