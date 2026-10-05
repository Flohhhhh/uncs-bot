import { Fragment } from "react";
import type { ServerActivityView } from "../../../../../src/admin/server-activity";
import { describeCause } from "../../../../../src/common/cause-labels";
import { isPublicIndividualSteamId } from "../../../../../src/common/steam-id";
import { useResource } from "../../api/use-resource";
import type { Audit, Player } from "../../api/types";
import { useGameAdmin } from "../../app/context";
import { OutcomeBadge, outcomeLabels } from "../../components/ui";
import { actionDefinitions } from "../actions/policy";
import type { CombatEvent, CombatResponse } from "../combat/combat.types";
import { PlayerButton, type SheetPlayer } from "../players/player-actions";

export type Category = "players" | "match" | "connection" | "combat" | "staff";
export const categories: Record<Category, string> = {
  players: "Players & teams",
  match: "Match changes",
  connection: "Connection",
  combat: "Kills & deaths",
  staff: "Staff & automation",
};
/** A player named in an entry; their name opens the player panel. */
type Who = { steamId: string; name: string };
type Segment = string | Who;
export type ActivityEntry = {
  id: string;
  at: string;
  category: Category;
  segments: Segment[];
  /** The entry as plain text, for sorting. */
  text: string;
  detail: string;
  outcome?: Audit["state"];
  /** Lowercased text that search matches, including raw values such as SteamIDs and weapon IDs. */
  search: string;
};

/** "Id.Item.AK74M" and "ID.Item.AK74M" read as "AK-74M", as on the public stats; the raw value stays searchable. */
export function weaponLabel(cause: string | null | undefined) {
  return cause?.trim() ? describeCause(cause).label : "";
}
function who(steamId: string | null | undefined, name: string | null | undefined, fallback: string): Segment {
  return steamId && isPublicIndividualSteamId(steamId)
    ? { steamId, name: name || steamId }
    : name || steamId || fallback;
}
function makeEntry(fields: Omit<ActivityEntry, "text" | "search">, raw: (string | null | undefined)[]): ActivityEntry {
  const text = fields.segments.map((segment) => (typeof segment === "string" ? segment : segment.name)).join("");
  const outcome = fields.outcome ? outcomeLabels[fields.outcome] : "";
  return { ...fields, text, search: [text, fields.detail, outcome, ...raw].join(" ").toLowerCase() };
}
/** The player's name at the start of an observation such as "UncDap joined" or "UncDap: RED → BLU". */
function leadingName(message: string, steamId: string, roster: Player[]) {
  const known = roster.find((player) => player.steamId === steamId)?.name;
  if (known && message.startsWith(known)) return known;
  return /^(.+?)(?: joined| left|: .+ → .+)$/.exec(message)?.[1] ?? "";
}
function observationEntry(event: ServerActivityView["events"][number], roster: Player[]) {
  const name =
    event.steamId && isPublicIndividualSteamId(event.steamId) ? leadingName(event.message, event.steamId, roster) : "";
  return makeEntry(
    {
      id: event.id,
      at: event.observedAt,
      category: event.category,
      segments: name ? [{ steamId: event.steamId!, name }, event.message.slice(name.length)] : [event.message],
      detail: "",
    },
    [event.steamId],
  );
}
function combatEntry(event: CombatEvent) {
  return makeEntry(
    {
      id: `combat:${event.serverInstanceId}:${event.eventId}`,
      at: event.receivedAt,
      category: "combat",
      segments: event.suicide
        ? [who(event.victimSteamId, event.victimName, "Player"), " died (suicide)"]
        : [
            who(event.killerSteamId, event.killerName, "Unknown killer"),
            " killed ",
            who(event.victimSteamId, event.victimName, "unknown player"),
          ],
      detail: [
        weaponLabel(event.cause),
        event.headshot ? "Headshot" : "",
        event.distanceMeters == null ? "" : `${Math.round(event.distanceMeters)} m`,
      ]
        .filter(Boolean)
        .join(" · "),
    },
    [event.killerSteamId, event.victimSteamId, event.cause],
  );
}
function actionEntry(action: Audit, roster: Player[]) {
  const player = isPublicIndividualSteamId(action.target)
    ? { steamId: action.target, name: roster.find((entry) => entry.steamId === action.target)?.name ?? action.target }
    : null;
  return makeEntry(
    {
      id: `action:${action.id}`,
      at: action.createdAt,
      category: "staff",
      segments: [
        `${action.actorName} · ${actionDefinitions[action.action]?.[0] || action.action}`,
        ...(player ? [" · ", player] : []),
      ],
      detail: [player || action.target === "server" ? "" : action.target, action.message].filter(Boolean).join(" · "),
      outcome: action.state,
    },
    [action.action, action.target],
  );
}

/** Recent observations, staff and automation receipts, and (optionally) received combat events, newest first. */
export function useActivityEntries(withCombat: boolean) {
  const { overview } = useGameAdmin();
  const observed = useResource<ServerActivityView>("activity");
  const combat = useResource<CombatResponse>(withCombat ? "combat?period=day" : null);
  const actions = useResource<Audit[]>("audit-notable");
  const roster = overview?.players ?? [];
  // Tolerate a malformed read: show what is valid instead of failing the page.
  const observations = observed.data?.events;
  const kills = combat.data?.events;
  const receipts = actions.data;
  const entries = [
    ...(Array.isArray(observations) ? observations : []).map((event) => observationEntry(event, roster)),
    ...(Array.isArray(kills) ? kills : []).map(combatEntry),
    ...(Array.isArray(receipts) ? receipts : []).map((action) => actionEntry(action, roster)),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const failed = [
    observed.error && "Server observations",
    combat.error && "Combat events",
    actions.error && "Action receipts",
  ].filter(Boolean);
  const loading =
    !observed.data && !combat.data && !actions.data && (observed.loading || combat.loading || actions.loading);
  return { entries, observed, combat, actions, failed, loading };
}

/** Clock time for today, date and time for older entries; the exact time is in the tooltip. */
export function When({ at }: { at: string }) {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return <>Not recorded</>;
  const value = new Date(time);
  const clock = value.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const today = value.toDateString() === new Date().toDateString();
  return (
    <time dateTime={value.toISOString()} title={value.toLocaleString()}>
      {today ? clock : `${value.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clock}`}
    </time>
  );
}

/** One feed line: "UncDap killed OldManRiver · AK-74M · 21 m", with player names as buttons when `onPlayer` is set. */
export function ActivityLine({ entry, onPlayer }: { entry: ActivityEntry; onPlayer?: (player: SheetPlayer) => void }) {
  return (
    <span className="activity-line">
      <strong>
        {entry.segments.map((segment, index) => (
          <Fragment key={index}>
            {typeof segment === "string" ? (
              segment
            ) : onPlayer ? (
              <PlayerButton player={segment} onOpen={onPlayer} />
            ) : (
              segment.name
            )}
          </Fragment>
        ))}
      </strong>
      {entry.outcome && <OutcomeBadge state={entry.outcome} />}
      {entry.detail && <span className="activity-detail"> · {entry.detail}</span>}
    </span>
  );
}
