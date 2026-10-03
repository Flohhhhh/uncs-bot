import { useState } from "react";
import { isPublicIndividualSteamId } from "../../../../../src/common/steam-id";
import { useResource } from "../../api/use-resource";
import { useAdmin } from "../../app/context";
import { Badge, Card, Empty, Search, Tabs, date } from "../../components/ui";
import { CopyValue, DataTable } from "../../components/data-table";
import { When, weaponLabel } from "../server/activity-entries";
import type {
  CombatEvent,
  CombatEventKind,
  CombatFeedDeliveries,
  CombatPeriod,
  CombatPlayer,
  CombatResponse,
} from "./combat.types";

const periods: Record<CombatPeriod, string> = { day: "Last 24 hours", week: "Last 7 days", month: "Last 30 days" };
const validSteamId = isPublicIndividualSteamId;
const count = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—";
const ratio = (player: CombatPlayer | null | undefined) =>
  typeof player?.kd === "number" && Number.isFinite(player.kd) ? player.kd.toFixed(2) : "—";
const headshotShare = (player: CombatPlayer) =>
  player.kills > 0 ? `${Math.round((player.headshotKills / player.kills) * 100)}%` : "—";
const shareOfKills = (part: number, kills: number) =>
  kills > 0 && Number.isFinite(part) ? `${Math.round((part / kills) * 100)}% of kills` : undefined;
const plural = (value: number, one: string, many: string) => `${count(value)} ${value === 1 ? one : many}`;

// Why deliveries that reached Gramps were refused or partly skipped, since it last started. A
// receipt time alone cannot show that every event of a batch was invalid or that the game's
// deliveries are being refused.
function FeedDeliveries({ feed }: { feed: CombatFeedDeliveries }) {
  const { lastBatch, lastRejected, rejectedCount, lastRejectedWithoutToken, rejectedWithoutTokenCount } = feed;
  const refusedLast = lastRejected && (!lastBatch || Date.parse(lastRejected.at) >= Date.parse(lastBatch.at));
  return (
    <>
      {lastRejected && (
        <p className={`notice ${refusedLast ? "warning" : "info"}`}>
          <strong>{refusedLast ? "Latest game feed delivery refused." : "Earlier game feed delivery refused."}</strong>{" "}
          {date(lastRejected.at)}: HTTP {lastRejected.status}, {lastRejected.reason}.{" "}
          {refusedLast ? "No batch has been accepted since. " : "Later batches were accepted. "}
          {plural(rejectedCount, "delivery", "deliveries")} with the feed token refused since Gramps started.
        </p>
      )}
      {lastBatch && lastBatch.invalid > 0 && (
        <p className="notice warning">
          <strong>Last batch skipped invalid entries.</strong> {date(lastBatch.at)}:{" "}
          {plural(lastBatch.accepted, "killed event", "killed events")} accepted,{" "}
          {plural(lastBatch.invalid, "invalid entry", "invalid entries")} skipped. First invalid:{" "}
          {lastBatch.firstInvalid ?? "not recorded"}.
        </p>
      )}
      {lastRejectedWithoutToken && rejectedWithoutTokenCount > 0 && (
        <p className="notice info">
          <strong>{plural(rejectedWithoutTokenCount, "request", "requests")} without the feed token refused</strong>{" "}
          since Gramps started. Latest {date(lastRejectedWithoutToken.at)}: HTTP {lastRejectedWithoutToken.status},{" "}
          {lastRejectedWithoutToken.reason}. Anyone can reach the feed URL, so these do not show that the game sent
          them. If no batches arrive, check the feed token the game uses.
        </p>
      )}
    </>
  );
}

function PlayerLink({
  id,
  name,
  disabled,
  onSelect,
}: {
  id: string | null;
  name: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const label = name || id || "Unknown player";
  return id && validSteamId(id) ? (
    <button type="button" className="combat-player-link" disabled={disabled} onClick={() => onSelect(id)}>
      {label}
    </button>
  ) : (
    <>{label}</>
  );
}

/** An inline row of recorded totals. */
function StatStrip({ label, items }: { label: string; items: { label: string; value: string; note?: string }[] }) {
  return (
    <dl className="combat-stats" aria-label={label}>
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>
            {item.value}
            {item.note && <small>{item.note}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function EventsTable({
  events,
  disabled,
  onSelect,
}: {
  events: CombatEvent[];
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <DataTable
      label="Combat events"
      rows={events}
      columns={[
        { label: "Received", value: (event) => Date.parse(event.receivedAt), firstDirection: "descending" },
        { label: "Killer", value: (event) => event.killerName || event.killerSteamId },
        { label: "Victim", value: (event) => event.victimName || event.victimSteamId },
        { label: "Weapon / cause", value: (event) => event.cause },
        { label: "Distance", value: (event) => event.distanceMeters, firstDirection: "descending" },
        { label: "Context", value: (event) => (event.headshot ? "Headshot" : event.suicide ? "Suicide" : null) },
      ]}
      renderRow={(event) => (
        <tr key={`${event.serverInstanceId}:${event.eventId}`}>
          <td className="combat-time">
            <When at={event.receivedAt} />
            {event.mapName && <small>{event.mapName}</small>}
          </td>
          <td>
            <strong>
              {event.killerSteamId ? (
                <PlayerLink id={event.killerSteamId} name={event.killerName} disabled={disabled} onSelect={onSelect} />
              ) : (
                event.killerName || "No killer reported"
              )}
            </strong>
            <small>{event.killerSteamId && <CopyValue value={event.killerSteamId} />}</small>
          </td>
          <td>
            <strong>
              <PlayerLink id={event.victimSteamId} name={event.victimName} disabled={disabled} onSelect={onSelect} />
            </strong>
            <small>{event.victimSteamId && <CopyValue value={event.victimSteamId} />}</small>
          </td>
          <td className="combat-cause" title={event.cause ?? undefined}>
            {weaponLabel(event.cause) || "Not reported"}
          </td>
          <td>
            {typeof event.distanceMeters === "number" && Number.isFinite(event.distanceMeters)
              ? `${event.distanceMeters.toLocaleString(undefined, { maximumFractionDigits: 1 })} m`
              : "—"}
          </td>
          <td>
            {event.headshot && <Badge>Headshot</Badge>} {event.suicide && <Badge>Suicide</Badge>}
            {!event.headshot && !event.suicide && "—"}
          </td>
        </tr>
      )}
    />
  );
}

interface CombatViewProps {
  period: CombatPeriod;
  playerId: string;
  query: string;
  onQuery: (query: string) => void;
  cause: string;
  onCause: (cause: string) => void;
  eventKind: CombatEventKind;
  onEventKind: (kind: CombatEventKind) => void;
  onSelect: (id: string) => void;
  disabled: boolean;
}

function CombatView({
  period,
  playerId,
  query,
  onQuery,
  cause,
  onCause,
  eventKind,
  onEventKind,
  onSelect,
  disabled,
}: CombatViewProps) {
  const path = `${playerId ? `combat/players/${encodeURIComponent(playerId)}` : "combat"}?period=${period}`;
  const { data: result, loading, refreshing, error, refresh } = useResource<CombatResponse>(path);
  // Keep the selected window/identity paired with its response even if a shared
  // resource hook briefly retains the previous result while changing its key.
  const data = result?.period === period && (playerId ? result.steamId === playerId : !result.steamId) ? result : null;
  const player = data?.player;
  const heading = playerId && (
    <div className="combat-player-heading">
      <div>
        <h2>{player?.name || "Player history"}</h2>
        <CopyValue value={playerId} />
      </div>
      <button type="button" className="button secondary small" disabled={disabled} onClick={() => onSelect("")}>
        ← Server leaderboard
      </button>
    </div>
  );
  if (!data) {
    return (
      <div aria-live="polite">
        {heading}
        <Empty
          title={error ? "Combat history could not be loaded" : "Loading combat history…"}
          detail={error ? "Try again. No empty history has been assumed." : undefined}
          action={
            error && (
              <button
                type="button"
                className="button secondary small"
                disabled={disabled || loading || refreshing}
                onClick={() => void refresh()}
              >
                Retry combat history
              </button>
            )
          }
        />
      </div>
    );
  }
  const leaderboard = data.leaderboard ?? [];
  const events = data.events;
  const search = query.trim().toLowerCase();
  const matches = (values: (string | null)[]) => values.some((value) => (value ?? "").toLowerCase().includes(search));
  const players = leaderboard.filter((entry) => matches([entry.name, entry.steamId]));
  const causes = [
    ...new Set(events.map((event) => event.cause).filter((value): value is string => Boolean(value))),
  ].sort();
  const filtered = events.filter(
    (event) =>
      matches([event.killerName, event.killerSteamId, event.victimName, event.victimSteamId, event.cause]) &&
      (eventKind !== "headshot" || event.headshot) &&
      (!cause || event.cause === cause),
  );
  // Feed status is unknown while the latest read failed; never show the old state as current.
  const feed = error
    ? "Status unavailable"
    : !data.enabled
      ? "Tracking off"
      : data.feedStatus === "receiving"
        ? "Receiving"
        : data.feedStatus === "quiet"
          ? "No recent batch"
          : "Waiting for the first batch";
  const tone = error ? "attention" : data.enabled && data.feedStatus === "receiving" ? "good" : "quiet";
  return (
    <div aria-busy={loading || refreshing}>
      {heading}
      {error && (
        <div className="notice error" role="alert">
          Combat history could not be refreshed. Showing the last received snapshot; feed status is unavailable.{" "}
          <button
            type="button"
            className="button secondary small"
            disabled={disabled || loading || refreshing}
            onClick={() => void refresh()}
          >
            Retry combat history
          </button>
        </div>
      )}
      <div className="status-row">
        <p className={`status-line ${tone}`}>
          <span>
            Combat feed: <strong>{feed}</strong>
          </span>
          {!error && data.feedStatus === "quiet" && <span>A quiet feed does not mean the server is offline.</span>}
          <span>Last batch {data.lastReceivedAt ? <When at={data.lastReceivedAt} /> : "not received yet"}</span>
          {data.trackingStartedAt && (
            <span>Tracking since {new Date(data.trackingStartedAt).toLocaleDateString()}</span>
          )}
        </p>
        <details className="status-about">
          <summary>About these numbers</summary>
          <div className="status-about-panel">
            <p>{data.coverageNote || "Only recorded combat events are included in this view."}</p>
            <p>The rolling window starts {date(data.windowStartedAt)}. Periods use the time each event was received.</p>
            <p>
              Kills exclude suicides. Headshot share is a share of recorded kills, not shooting accuracy. K/D shows —
              when no deaths were recorded.
            </p>
            <p>Recorded statistics are for human review, not a cheating verdict.</p>
          </div>
        </details>
      </div>
      {!playerId && "rejectedCount" in data && <FeedDeliveries feed={data} />}
      {!data.connected && !data.trackingStartedAt && !data.totals.events ? (
        <Empty
          title={!data.enabled ? "Combat tracking is off" : "Waiting for the first combat events"}
          detail="Statistics appear after the game delivers events to Gramps."
        />
      ) : (
        <>
          {playerId ? (
            <StatStrip
              label={`Recorded totals, ${periods[period].toLowerCase()}`}
              items={[
                { label: "Kills", value: count(player?.kills) },
                { label: "Deaths", value: count(player?.deaths) },
                {
                  label: "K / D",
                  value: ratio(player),
                  note: player?.deaths === 0 ? "No recorded deaths in this period" : undefined,
                },
                {
                  label: "Headshot kills",
                  value: count(player?.headshotKills),
                  note: player ? shareOfKills(player.headshotKills, player.kills) : undefined,
                },
              ]}
            />
          ) : (
            <StatStrip
              label={`Recorded totals, ${periods[period].toLowerCase()}`}
              items={[
                { label: "Recorded kills", value: count(data.totals.kills) },
                { label: "Recorded deaths", value: count(data.totals.deaths) },
                { label: "Players recorded", value: count(data.totals.players) },
                {
                  label: "Headshot kills",
                  value: count(data.totals.headshotKills),
                  note: shareOfKills(data.totals.headshotKills, data.totals.kills),
                },
              ]}
            />
          )}
          <Search value={query} onChange={onQuery} placeholder="Search player, SteamID, or weapon" />
          {!playerId && (
            <Card
              title="Server leaderboard"
              subtitle={`${periods[period]} · up to 100 players · select a player to view their history`}
              className="combat-leaderboard"
            >
              {players.length ? (
                <DataTable
                  label="Server leaderboard"
                  rows={players}
                  columns={[
                    { label: "Player", value: (entry) => entry.name || entry.steamId },
                    { label: "Kills", value: (entry) => entry.kills, firstDirection: "descending" },
                    { label: "Deaths", value: (entry) => entry.deaths, firstDirection: "descending" },
                    { label: "K / D", value: (entry) => entry.kd, firstDirection: "descending" },
                    { label: "Headshot kills", value: (entry) => entry.headshotKills, firstDirection: "descending" },
                  ]}
                  renderRow={(entry) => (
                    <tr key={entry.steamId}>
                      <td>
                        <strong>
                          <PlayerLink id={entry.steamId} name={entry.name} disabled={disabled} onSelect={onSelect} />
                        </strong>
                        <small>
                          <CopyValue value={entry.steamId} />
                        </small>
                      </td>
                      <td>{count(entry.kills)}</td>
                      <td>{count(entry.deaths)}</td>
                      <td>{ratio(entry)}</td>
                      <td>
                        {count(entry.headshotKills)} <span className="muted">· {headshotShare(entry)}</span>
                      </td>
                    </tr>
                  )}
                />
              ) : (
                <Empty
                  title={leaderboard.length ? "No matching players" : "No recorded player stats yet"}
                  detail={
                    leaderboard.length
                      ? "Try another name or SteamID."
                      : data.connected
                        ? "Player history will appear as combat events arrive."
                        : "Connect the combat feed to begin recording player history. Earlier matches are not reconstructed."
                  }
                />
              )}
            </Card>
          )}
          <Card
            title={playerId ? "Player combat events" : "Recent combat events"}
            subtitle={`${filtered.length} shown of the latest ${events.length} (up to 100) · times are when each event was received`}
          >
            <div className="combat-filters">
              <label>
                Event type
                <select
                  value={eventKind}
                  disabled={disabled}
                  onChange={(event) => onEventKind(event.target.value === "headshot" ? "headshot" : "all")}
                >
                  <option value="all">All events</option>
                  <option value="headshot">Headshot kills</option>
                </select>
              </label>
              <label>
                Weapon / cause
                <select value={cause} disabled={disabled} onChange={(event) => onCause(event.target.value)}>
                  <option value="">All reported causes</option>
                  {cause && !causes.includes(cause) && (
                    <option value={cause}>{weaponLabel(cause)} (not in recent events)</option>
                  )}
                  {causes.map((value) => (
                    <option key={value} value={value}>
                      {weaponLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
              <p>Filters apply to these recent events. Stats cover the full recorded period.</p>
              {(query || cause || eventKind !== "all") && (
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => {
                    onQuery("");
                    onCause("");
                    onEventKind("all");
                  }}
                >
                  Reset filters
                </button>
              )}
            </div>
            {filtered.length ? (
              <EventsTable events={filtered} disabled={disabled} onSelect={onSelect} />
            ) : (
              <Empty
                title={events.length ? "No events match these filters" : "No combat events recorded in this period"}
                detail={
                  events.length
                    ? "Change the search, event type, or weapon filter."
                    : "This is recorded history; an empty feed does not mean nobody played."
                }
              />
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * Combat history. Pass `playerId` and `onPlayerChange` to keep the chosen player outside the page,
 * such as in the Activity hub's URL; otherwise the page holds it.
 */
export function CombatPage({
  playerId: chosenPlayer,
  onPlayerChange,
}: { playerId?: string; onPlayerChange?: (id: string) => void } = {}) {
  const { me, busy, dialogOpen } = useAdmin();
  const [period, setPeriod] = useState<CombatPeriod>("week");
  const [ownPlayer, setOwnPlayer] = useState("");
  const playerId = chosenPlayer ?? ownPlayer;
  const [query, setQuery] = useState("");
  const [cause, setCause] = useState("");
  const [eventKind, setEventKind] = useState<CombatEventKind>("all");
  const disabled = busy || dialogOpen;
  const selectPlayer = (id: string) => {
    if (disabled || (id && !validSteamId(id))) return;
    (onPlayerChange ?? setOwnPlayer)(id);
    setQuery("");
    setCause("");
    setEventKind("all");
  };
  if (!me) return null;
  return (
    <Tabs
      label="Combat history period"
      className="combat-periods"
      tabs={(Object.keys(periods) as CombatPeriod[]).map((id) => ({ id, label: periods[id], disabled }))}
      value={period}
      onChange={(value) => {
        if (disabled) return;
        setPeriod(value);
        setQuery("");
        setCause("");
      }}
    >
      {(selected) => (
        <CombatView
          key={`${selected}:${playerId}`}
          period={selected}
          playerId={playerId}
          query={query}
          onQuery={setQuery}
          cause={cause}
          onCause={setCause}
          eventKind={eventKind}
          onEventKind={setEventKind}
          onSelect={selectPlayer}
          disabled={disabled}
        />
      )}
    </Tabs>
  );
}
