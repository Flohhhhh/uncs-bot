import { useState } from "react";
import type { ServerActivityView } from "../../../../../src/admin/server-activity";
import { useResource } from "../../api/use-resource";
import type { Audit } from "../../api/types";
import { useGameAdmin } from "../../app/context";
import { Badge, Card, Empty, Search, date } from "../../components/ui";
import { DataTable } from "../../components/data-table";
import { actionDefinitions } from "../actions/policy";
import { CombatPage } from "../combat/combat-page";
import type { CombatResponse } from "../combat/combat.types";
import { DashboardHistory } from "./pages";
import { GameLogView } from "./game-log";

type Category = "players" | "match" | "connection" | "combat" | "staff";
type Entry = {
  id: string;
  at: string;
  category: Category;
  message: string;
  detail?: string;
  search?: string;
  source: string;
};
const categories: Record<Category, string> = {
  players: "Players & teams",
  match: "Match changes",
  connection: "Connection",
  combat: "Kills & deaths",
  staff: "Staff & automation",
};

export function ActivityFeed() {
  const observed = useResource<ServerActivityView>("activity");
  const combat = useResource<CombatResponse>("combat?period=day");
  const actions = useResource<Audit[]>("audit-notable");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [paused, setPaused] = useState<Entry[] | null>(null);
  const entries: Entry[] = [
    ...(observed.data?.events ?? []).map((event) => ({
      id: event.id,
      at: event.observedAt,
      category: event.category,
      message: event.message,
      detail: event.steamId,
      source: "Observed in game",
    })),
    ...(combat.data?.events ?? []).map((event) => ({
      id: `combat:${event.serverInstanceId}:${event.eventId}`,
      at: event.receivedAt,
      category: "combat" as const,
      message: event.suicide
        ? `${event.victimName || event.victimSteamId || "Player"} died (suicide)`
        : `${event.killerName || event.killerSteamId || "Unknown killer"} killed ${event.victimName || event.victimSteamId || "unknown player"}`,
      detail: [
        event.cause,
        event.headshot ? "Headshot" : "",
        event.distanceMeters == null ? "" : `${Math.round(event.distanceMeters)} m`,
      ]
        .filter(Boolean)
        .join(" · "),
      search: [event.killerSteamId, event.victimSteamId].join(" "),
      source: "Game event · received",
    })),
    ...(actions.data ?? []).map((action) => ({
      id: `action:${action.id}`,
      at: action.createdAt,
      category: "staff" as const,
      message: `${action.actorName} · ${actionDefinitions[action.action]?.[0] || action.action} · ${action.state === "started" ? "Unconfirmed" : action.state}`,
      detail: [action.target === "server" ? "" : action.target, action.message].filter(Boolean).join(" · "),
      source: "Action receipt",
    })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const rows = (paused ?? entries).filter(
    (event) =>
      (!category || event.category === category) &&
      [event.message, event.detail, event.source, event.search].some((value) =>
        value?.toLowerCase().includes(query.trim().toLowerCase()),
      ),
  );
  const failed = [
    observed.error && "Server observations",
    combat.error && "Combat events",
    actions.error && "Action receipts",
  ].filter(Boolean);
  const loading =
    !observed.data && !combat.data && !actions.data && (observed.loading || combat.loading || actions.loading);
  return (
    <>
      <div className="toolbar activity-sources">
        <Badge kind={observed.error || observed.data?.connection === "unavailable" ? "warn" : "neutral"}>
          {observed.error
            ? "Game status unavailable"
            : observed.data?.connection === "available"
              ? "Game connected"
              : observed.data?.connection === "unavailable"
                ? "Game connection unavailable"
                : "Checking game"}
        </Badge>
        <Badge>
          {combat.error
            ? "Combat feed unavailable"
            : !combat.data
              ? "Checking combat feed"
              : !combat.data.enabled
                ? "Combat feed off"
                : combat.data.feedStatus === "receiving"
                  ? "Combat feed receiving"
                  : combat.data.feedStatus === "quiet"
                    ? "No recent combat batch"
                    : "Awaiting first combat batch"}
        </Badge>
        <button type="button" className="button secondary small" onClick={() => setPaused(paused ? null : entries)}>
          {paused ? "Resume display" : "Pause display"}
        </button>
      </div>
      {paused && (
        <p role="status" className="notice info">
          Display paused for reading. Server monitoring continues.
        </p>
      )}
      {failed.length > 0 && (
        <p role="alert" className="notice warning">
          Could not refresh: {failed.join(", ")}. Other sources remain visible; retained entries may be old.
        </p>
      )}
      <Search value={query} onChange={setQuery} placeholder="Search activity, player or SteamID">
        <select aria-label="Activity type" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="">All activity</option>
          {Object.entries(categories).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </Search>
      <Card title="Server activity" subtitle={`${rows.length} recent entries`}>
        {loading ? (
          <Empty title="Loading server activity…" />
        ) : rows.length ? (
          <DataTable
            label="Server activity"
            rows={rows}
            columns={[
              { label: "When", value: (event) => Date.parse(event.at), firstDirection: "descending" },
              { label: "Type", value: (event) => categories[event.category] },
              { label: "Activity", value: (event) => event.message },
              { label: "Source", value: (event) => event.source },
            ]}
            renderRow={(event) => (
              <tr key={event.id}>
                <td>{date(event.at)}</td>
                <td>{categories[event.category]}</td>
                <td>
                  <strong>{event.message}</strong>
                  {event.detail && <small className="audit-detail">{event.detail}</small>}
                </td>
                <td>{event.source}</td>
              </tr>
            )}
          />
        ) : (
          <Empty title={failed.length ? "Activity could not be fully loaded" : "No matching activity yet"} />
        )}
      </Card>
      <details className="activity-coverage">
        <summary>What this feed records</summary>
        <p>
          Player joins, departures, team changes, map/rule/zone/lighting changes, round-clock changes and connection
          changes are observations from normal server reads. They can miss events between reads. Gaps are marked.
        </p>
        <p>
          Recent observations are held while Gramps is running (up to {observed.data?.limit ?? 300}); they restart with
          Gramps. This run began {date(observed.data?.startedAt)}. Staff actions and received combat events have
          separate stored histories.
        </p>
        <p>
          Action receipts include moderation, announcements, map/settings changes and automation, with their actual
          outcome. Accepted or pending does not mean applied. Automatic welcome and round messages the game acknowledged
          are listed only in Action history; failed or unconfirmed ones appear here. Kills and deaths appear when the
          native game feed delivers them. Game chat and events the server does not expose are not recorded.
        </p>
      </details>
    </>
  );
}

export function ActivityPage({ initialView = "feed" }: { initialView?: "feed" | "combat" | "actions" }) {
  const { me } = useGameAdmin();
  const [view, setView] = useState<string>(initialView);
  return (
    <>
      <div className="settings-tabs" role="group" aria-label="Activity views">
        {[
          ["feed", "All activity"],
          ["combat", "Combat history"],
          ["actions", "Action history"],
          ...(me.role === "admin" ? [["game", "Game command log"]] : []),
        ].map(([key, label]) => (
          <button
            type="button"
            className="button secondary"
            key={key}
            aria-pressed={view === key}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {view === "feed" ? (
        <ActivityFeed />
      ) : view === "combat" ? (
        <CombatPage />
      ) : view === "game" && me.role === "admin" ? (
        <GameLogView />
      ) : (
        <DashboardHistory />
      )}
    </>
  );
}
