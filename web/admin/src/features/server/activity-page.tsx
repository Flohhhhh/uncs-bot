import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { isPublicIndividualSteamId } from "../../../../../src/common/steam-id";
import { useGameAdmin } from "../../app/context";
import { Card, Empty, Search, Tabs, date, type TabOption } from "../../components/ui";
import { DataTable } from "../../components/data-table";
import { CombatPage } from "../combat/combat-page";
import { PlayerSheet, type SheetPlayer } from "../players/player-actions";
import { DashboardHistory, actionIdPattern } from "./pages";
import { GameLogView } from "./game-log";
import { RepeatOffenders } from "./repeat-offenders";
import {
  ActivityLine,
  When,
  categories,
  useActivityEntries,
  type ActivityEntry,
  type Category,
} from "./activity-entries";

/** A "?" popover that closes on Escape or a click elsewhere. */
function HelpPopover({ label, children }: { label: string; children: ReactNode }) {
  const popover = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent | KeyboardEvent) => {
      const element = popover.current;
      if (!element?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        element.open = false;
        element.querySelector("summary")?.focus();
      } else if (!element.contains(event.target as Node)) element.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  return (
    <details ref={popover} className="activity-help">
      <summary aria-label={label} title={label}>
        ?
      </summary>
      <div className="activity-help-panel">{children}</div>
    </details>
  );
}

// Kills are most of the feed; staff turn them on when they need them.
const defaultCategories: Category[] = ["players", "match", "connection", "staff"];

export function ActivityFeed() {
  const { entries, observed, combat, failed, loading } = useActivityEntries(true);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<ReadonlySet<Category>>(() => new Set(defaultCategories));
  const [paused, setPaused] = useState<ActivityEntry[] | null>(null);
  const [sheet, setSheet] = useState<SheetPlayer | null>(null);
  const search = query.trim().toLowerCase();
  const matching = (paused ?? entries).filter((entry) => entry.search.includes(search));
  const rows = matching.filter((entry) => shown.has(entry.category));
  const game = observed.error
    ? "Game status unavailable"
    : observed.data?.connection === "available"
      ? "Game connected"
      : observed.data?.connection === "unavailable"
        ? "Game connection unavailable"
        : "Checking game";
  const feed = combat.error
    ? "unavailable"
    : !combat.data
      ? "checking"
      : !combat.data.enabled
        ? "off"
        : combat.data.feedStatus === "receiving"
          ? "receiving"
          : combat.data.feedStatus === "quiet"
            ? "no recent batch"
            : "awaiting first batch";
  const attention = !!observed.error || observed.data?.connection === "unavailable" || !!combat.error;
  return (
    <>
      <div className="activity-head">
        <p className={`activity-status${attention ? " attention" : ""}`}>
          {game} · Combat feed: {feed}
        </p>
        <HelpPopover label="What this feed records">
          <p>
            Joins, departures, team changes, map, rule, zone and lighting changes, the round clock and the connection
            come from normal server reads, so changes between reads can be missed. Gaps are marked.
          </p>
          <p>
            Up to {observed.data?.limit ?? 300} recent observations are kept while Gramps runs; this run began{" "}
            {date(observed.data?.startedAt)}. Staff actions and combat events have their own stored history.
          </p>
          <p>
            Staff and automation entries show their actual outcome; accepted or pending does not mean applied.
            Acknowledged automatic welcome and round messages are only in Action history. Kills appear when the game
            feed delivers them. Game chat is not recorded.
          </p>
        </HelpPopover>
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
        <div className="filter-chips" role="group" aria-label="Activity types">
          {(Object.keys(categories) as Category[]).map((category) => (
            <button
              type="button"
              key={category}
              className="filter-chip"
              aria-pressed={shown.has(category)}
              onClick={() =>
                setShown((previous) => {
                  const next = new Set(previous);
                  if (next.has(category)) next.delete(category);
                  else next.add(category);
                  return next;
                })
              }
            >
              {categories[category]}{" "}
              <span className="chip-count">{matching.filter((entry) => entry.category === category).length}</span>
            </button>
          ))}
        </div>
      </Search>
      <Card
        className="activity-feed"
        title={`${rows.length} recent ${rows.length === 1 ? "entry" : "entries"}`}
        subtitle={matching.length > rows.length ? `${matching.length - rows.length} more in hidden types` : undefined}
      >
        {loading ? (
          <Empty title="Loading server activity…" />
        ) : rows.length ? (
          <DataTable
            label="Server activity"
            rows={rows}
            columns={[
              { label: "When", value: (entry) => Date.parse(entry.at), firstDirection: "descending" },
              { label: "Activity", value: (entry) => entry.text },
            ]}
            renderRow={(entry) => (
              <tr key={entry.id}>
                <td className="activity-when">
                  <When at={entry.at} />
                </td>
                <td>
                  <ActivityLine entry={entry} onPlayer={setSheet} />
                </td>
              </tr>
            )}
          />
        ) : (
          <Empty title={failed.length ? "Activity could not be fully loaded" : "No matching activity yet"} />
        )}
      </Card>
      {sheet && <PlayerSheet player={sheet} onClose={() => setSheet(null)} />}
    </>
  );
}

type View = "feed" | "combat" | "actions" | "commands";

/**
 * The activity hub. The view and a focused player live in the URL (`?view=combat&player=…`) beside `server`.
 * `?view=actions&id=<action ID>` opens that action's stored receipt.
 */
export function ActivityPage() {
  const { me } = useGameAdmin();
  const [params, setParams] = useSearchParams();
  const tabs: TabOption<View>[] = [
    { id: "feed", label: "All activity" },
    { id: "combat", label: "Combat history" },
    { id: "actions", label: "Action history" },
    ...(me.role === "admin" ? [{ id: "commands" as const, label: "Game command log" }] : []),
  ];
  const view = tabs.find((tab) => tab.id === params.get("view"))?.id ?? "feed";
  const requested = params.get("player") ?? "";
  const player = isPublicIndividualSteamId(requested) ? requested : "";
  const requestedId = params.get("id")?.trim() ?? "";
  const receipt = actionIdPattern.test(requestedId) ? requestedId.toLowerCase() : "";
  const update = (changes: Record<string, string>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );
  return (
    <Tabs
      label="Activity views"
      tabs={tabs}
      value={view}
      onChange={(next) => update({ view: next, player: "", id: "" })}
    >
      {(selected) =>
        selected === "combat" ? (
          <CombatPage playerId={player} onPlayerChange={(id) => update({ player: id })} />
        ) : selected === "actions" ? (
          <>
            {/* A linked receipt or player is a lookup; the list is for browsing Action history. */}
            {!receipt && !player && <RepeatOffenders />}
            <DashboardHistory key={receipt || player} initialQuery={receipt || player} />
          </>
        ) : selected === "commands" ? (
          <GameLogView />
        ) : (
          <ActivityFeed />
        )
      }
    </Tabs>
  );
}
