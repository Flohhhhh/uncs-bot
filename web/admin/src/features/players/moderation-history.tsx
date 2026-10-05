import { useResource } from "../../api/use-resource";
import type { ModerationCount, PlayerModeration } from "../../api/types";
import { OutcomeBadge } from "../../components/ui";

const day = (value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const times = (count: number) => (count === 1 ? "once" : `${count} times`);

/** "last Oct 2 by Mod: Team killing" */
export function lastText(record: ModerationCount) {
  return `last ${day(record.lastAt)} by ${record.lastBy}${record.lastReason ? `: ${record.lastReason}` : ""}`;
}

/**
 * The player's kicks and bans through this dashboard on the selected server, failed ones left out.
 * A clean record shows nothing.
 */
export function ModerationHistory({ steamId }: { steamId: string }) {
  const { data, error } = useResource<PlayerModeration>(`moderation/players/${steamId}`);
  if (error && !data) return <p className="player-history muted">Kick and ban history could not be loaded.</p>;
  if (!data || (!data.kicks && !data.bans)) return null;
  const lines: string[] = [];
  if (data.kicks) lines.push(`Kicked ${times(data.kicks.count)} · ${lastText(data.kicks)}`);
  if (data.bans) lines.push(`Banned ${times(data.bans.count)} · ${lastText(data.bans)}`);
  const entries = data.entries ?? [];
  return (
    <section className="player-history" aria-label="Kicks and bans">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {/* The summary already names the newest kick and ban; older ones wait behind a click. */}
      {entries.length > lines.length && (
        <details>
          <summary>Recent kicks and bans</summary>
          <ul>
            {entries.map((entry) => (
              <li key={entry.id}>
                {day(entry.createdAt)} · {entry.action === "ban" ? "Ban" : "Kick"} by {entry.actorName}
                {entry.details?.reason ? `: ${entry.details.reason}` : ""}
                {entry.state !== "applied" && (
                  <>
                    {" "}
                    <OutcomeBadge state={entry.state} />
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
