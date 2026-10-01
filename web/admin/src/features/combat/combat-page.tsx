import { useState } from "react";
import { isPublicIndividualSteamId } from "../../../../../src/common/steam-id";
import { useResource } from "../../api/use-resource";
import { useAdmin } from "../../app/context";
import { Badge, Card, Empty, Metric, Search, date } from "../../components/ui";
import { CopyValue, DataTable } from "../../components/data-table";
import type { CombatEvent, CombatEventKind, CombatPeriod, CombatPlayer, CombatResponse } from "./combat.types";

const periods: Record<CombatPeriod, string> = { day: "Last 24 hours", week: "Last 7 days", month: "Last 30 days" };
const validSteamId = isPublicIndividualSteamId;
const count = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—";
const ratio = (player: CombatPlayer | null | undefined) =>
  typeof player?.kd === "number" && Number.isFinite(player.kd) ? player.kd.toFixed(2) : "—";
const headshotShare = (player: CombatPlayer) =>
  player.kills > 0 ? `${Math.round((player.headshotKills / player.kills) * 100)}%` : "—";

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
            {date(event.receivedAt)}
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
          <td className="combat-cause">{event.cause || "Not reported"}</td>
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
  const { data: result, loading, error, refresh } = useResource<CombatResponse>(path);
  // Keep the selected window/identity paired with its response even if a shared
  // resource hook briefly retains the previous result while changing its key.
  const data = result?.period === period && (playerId ? result.steamId === playerId : !result.steamId) ? result : null;
  if (!data) {
    return (
      <div aria-live="polite">
        <Empty
          title={error ? "Combat history could not be loaded" : "Loading combat history…"}
          detail={error ? "Try again. No empty history has been assumed." : undefined}
        />
        {error && (
          <button
            type="button"
            className="button secondary small"
            disabled={disabled || loading}
            onClick={() => void refresh()}
          >
            Retry combat history
          </button>
        )}
      </div>
    );
  }
  const leaderboard = data.leaderboard ?? [];
  const events = data.events;
  const search = query.trim().toLowerCase();
  const matches = (values: (string | null)[]) => values.some((value) => (value ?? "").toLowerCase().includes(search));
  const players = leaderboard.filter((player) => matches([player.name, player.steamId]));
  const causes = [
    ...new Set(events.map((event) => event.cause).filter((value): value is string => Boolean(value))),
  ].sort();
  const filtered = events.filter(
    (event) =>
      matches([event.killerName, event.killerSteamId, event.victimName, event.victimSteamId, event.cause]) &&
      (eventKind !== "headshot" || event.headshot) &&
      (!cause || event.cause === cause),
  );
  const player = data.player;
  const feedLabel = !data.enabled
    ? "FEED NOT CONNECTED"
    : data.feedStatus === "receiving"
      ? "FEED RECEIVING"
      : data.feedStatus === "quiet"
        ? "NO RECENT BATCH"
        : "WAITING FOR FEED";
  return (
    <div aria-busy={loading}>
      {error && (
        <div className="notice error" role="alert">
          Combat history could not be refreshed. Showing the last received snapshot; feed status is unavailable.{" "}
          <button
            type="button"
            className="button secondary small"
            disabled={disabled || loading}
            onClick={() => void refresh()}
          >
            Retry combat history
          </button>
        </div>
      )}
      <div className="combat-coverage">
        <div>
          <Badge kind={error ? "warn" : data.enabled && data.feedStatus === "receiving" ? "good" : "neutral"}>
            {error ? "FEED STATUS UNAVAILABLE" : feedLabel}
          </Badge>
          <p>
            {data.coverageNote || "Only recorded combat events are included in this view."}
            {data.feedStatus === "quiet" && " A quiet feed does not mean the server is offline."}
          </p>
          <p className="combat-window">
            Rolling window starts {date(data.windowStartedAt)}. Periods use event receipt times.
          </p>
          <p>Recorded statistics are for human review, not a cheating verdict.</p>
        </div>
        <dl>
          <div>
            <dt>Tracking started</dt>
            <dd>{date(data.trackingStartedAt)}</dd>
          </div>
          <div>
            <dt>Last batch received</dt>
            <dd>{date(data.lastReceivedAt)}</dd>
          </div>
        </dl>
      </div>
      {playerId ? (
        <>
          <div className="combat-player-heading">
            <div>
              <p className="eyebrow">PLAYER HISTORY / {periods[period].toUpperCase()}</p>
              <h2>{player?.name || "Player history"}</h2>
              <p className="muted">{playerId}</p>
            </div>
            <Badge>RECORDED EVENTS</Badge>
          </div>
          <div className="metrics">
            <Metric label="KILLS" value={count(player?.kills)} note="Recorded kills in this period" />
            <Metric label="DEATHS" value={count(player?.deaths)} note="Recorded deaths in this period" />
            <Metric
              label="K / D"
              value={ratio(player)}
              note={player?.deaths === 0 ? "No recorded deaths in this period" : "Per recorded death"}
            />
            <Metric
              label="HEADSHOT KILLS"
              value={count(player?.headshotKills)}
              note={player ? `${headshotShare(player)} of recorded kills` : "Share of kills, not shooting accuracy"}
            />
          </div>
        </>
      ) : (
        <div className="metrics">
          <Metric label="RECORDED KILLS" value={count(data.totals.kills)} note="Player kills, excluding suicides" />
          <Metric label="RECORDED DEATHS" value={count(data.totals.deaths)} note="Deaths in the captured feed" />
          <Metric label="PLAYERS RECORDED" value={count(data.totals.players)} note="Distinct players in this period" />
          <Metric
            label="HEADSHOT KILLS"
            value={count(data.totals.headshotKills)}
            note="Recorded headshot kill events"
          />
        </div>
      )}
      <Search value={query} onChange={onQuery} placeholder="Search player, SteamID, or weapon" />
      {!playerId && (
        <Card
          title="Server leaderboard"
          subtitle={`${periods[period]} · up to 100 players · select a player to view their history`}
          badge={<Badge>RECORDED KILLS</Badge>}
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
          <p className="combat-stat-note">
            Headshot percentage is a share of recorded kills. K/D is shown as — when no deaths were recorded.
          </p>
        </Card>
      )}
      <Card
        title={playerId ? "Player combat events" : "Recent combat events"}
        subtitle={`${filtered.length} shown from the latest ${events.length} events (up to 100) · timestamps show receipt time`}
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
              {cause && !causes.includes(cause) && <option value={cause}>{cause} (not in recent events)</option>}
              {causes.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <p>Filters apply to these recent events. Stats cover the full recorded period.</p>
          {(query || cause || eventKind !== "all") && (
            <button
              type="button"
              className="button secondary"
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
    </div>
  );
}

export function CombatPage() {
  const { me, busy, dialogOpen } = useAdmin();
  const [period, setPeriod] = useState<CombatPeriod>("week");
  const [playerId, setPlayerId] = useState("");
  const [query, setQuery] = useState("");
  const [cause, setCause] = useState("");
  const [eventKind, setEventKind] = useState<CombatEventKind>("all");
  const disabled = busy || dialogOpen;
  const selectPlayer = (id: string) => {
    if (disabled || (id && !validSteamId(id))) return;
    setPlayerId(id);
    setQuery("");
    setCause("");
    setEventKind("all");
  };
  if (!me) return null;
  return (
    <>
      <div className="combat-toolbar">
        <div className="period-switch" role="group" aria-label="Combat history period">
          {(Object.keys(periods) as CombatPeriod[]).map((value) => (
            <button
              type="button"
              key={value}
              className={value === period ? "active" : ""}
              aria-pressed={value === period}
              disabled={disabled}
              onClick={() => {
                setPeriod(value);
                setQuery("");
                setCause("");
              }}
            >
              {periods[value]}
            </button>
          ))}
        </div>
        {playerId && (
          <button type="button" className="button secondary small" disabled={disabled} onClick={() => selectPlayer("")}>
            ← Server leaderboard
          </button>
        )}
      </div>
      <CombatView
        key={`${period}:${playerId}`}
        period={period}
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
    </>
  );
}
