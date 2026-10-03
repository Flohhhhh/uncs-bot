import type { mapVoteView } from "../../../../../src/map-votes/map-votes.types";
import type { AutomaticVoteStatus } from "../../../../../src/common/map-vote-automation";
import { selectionLabel } from "../../../../../src/common/map-labels";
import {
  automationSettings,
  closeThreshold,
  type VoteAutomation,
  type VoteReminder,
} from "../../../../../src/common/voting-policy";
import { Badge, Card, date } from "../../components/ui";

export type Vote = ReturnType<typeof mapVoteView>;
export type VoteList = {
  enabled: boolean;
  serverId: string;
  observedAt?: string;
  votes: Vote[];
  automatic?: AutomaticVoteStatus | null;
};
export const voteStateLabels = {
  publishing: "Creating ballot",
  open: "Voting open",
  closing: "Counting votes",
  queued: "Winner queued",
  no_votes: "No votes",
  tied: "Tie · rotation kept",
  cancelled: "Closed",
  needs_review: "Needs review",
};

const activeStates: readonly string[] = ["publishing", "open", "closing", "needs_review"];
/** The ballot that still needs attention, if any. */
export function activeVote(data: VoteList) {
  return data.votes.find((item) => activeStates.includes(item.state));
}
const shortTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/**
 * The ballot's own close score. Ballots stored with settings can also close one scoring step early, from 10
 * points below it; older ballots close exactly at it.
 */
function closeRule(automation: VoteAutomation) {
  const { score, early } = closeThreshold(automation);
  return automation.settings
    ? {
        short: `ends by ${score} points`,
        full: `Closes when the leading team reaches ${score} points, or from ${early} if one more scoring step could end the match`,
      }
    : { short: `ends at ${score} points`, full: `Closes when the leading team reaches ${score} points` };
}
/** One short line for summaries: "None", "Off", or "Open · ends 12:52". */
export function voteSummary(data: VoteList | null | undefined, error = ""): { label: string; kind: string } {
  if (!data) return { label: error ? "Unavailable" : "Checking…", kind: error ? "warn" : "neutral" };
  // A failed refresh never presents the last answer as current.
  if (error) return { label: "Unavailable", kind: "warn" };
  if (!data.enabled) return { label: "Off", kind: "neutral" };
  const vote = activeVote(data);
  if (!vote) return { label: "None", kind: "neutral" };
  if (vote.state === "open")
    return {
      label: `Open · ${vote.automation ? closeRule(vote.automation).short : `ends ${shortTime(vote.closesAt)}`}`,
      kind: "good",
    };
  return { label: voteStateLabels[vote.state], kind: vote.state === "needs_review" ? "warn" : "neutral" };
}

export function VoteResults({ data, error = "" }: { data: VoteList; error?: string }) {
  const vote = activeVote(data) ?? data.votes[0];
  const total = vote?.counted ? vote.counts.reduce((sum, count) => sum + count, 0) : null;
  const historical = vote && ["queued", "no_votes", "tied", "cancelled"].includes(vote.state);
  return (
    <Card
      title={historical ? "Last map vote" : "Community map vote"}
      badge={
        <Badge kind={error || vote?.state === "needs_review" ? "warn" : "neutral"}>
          {error ? "Status unavailable" : !data.enabled ? "Off" : vote ? voteStateLabels[vote.state] : "No active vote"}
        </Badge>
      }
    >
      <div className="card-body">
        {data.enabled && data.automatic?.enabled && (
          <p className="muted">Automatic voting · {data.automatic.message}</p>
        )}
        {error && (
          <p role="alert" className="notice warning">
            Voting status and totals could not refresh. Showing the last successful check.
          </p>
        )}
        {!data.enabled ? (
          <p>
            {error
              ? "Voting was off at the last successful check."
              : "Community voting is not enabled. The saved rotation chooses the next map."}
          </p>
        ) : !vote ? (
          <p>No ballot has opened yet.</p>
        ) : (
          <>
            <p>
              {vote.state === "open"
                ? vote.automation
                  ? closeRule(vote.automation).full
                  : `Closes ${date(vote.closesAt)}`
                : vote.message}
              {total !== null && ` · ${total} ${total === 1 ? "vote" : "votes"}`}
            </p>
            <ol className="vote-results" aria-label="Map vote totals">
              {vote.choices.map((choice, index) => (
                <li key={index}>
                  <div>
                    <span>
                      {selectionLabel(choice)}
                      {vote.winner === index && " · Winner"}
                    </span>
                    <strong>{vote.counted ? `${vote.counts[index] ?? 0} votes` : "Not counted"}</strong>
                  </div>
                  {vote.counted && (
                    <progress
                      max={Math.max(total ?? 0, 1)}
                      value={vote.counts[index] ?? 0}
                      aria-label={`${selectionLabel(choice)} votes`}
                    />
                  )}
                </li>
              ))}
            </ol>
            {data.observedAt && (
              <small className="muted">Totals checked {date(data.observedAt)}. Refreshes with the dashboard.</small>
            )}
            {vote.automation &&
              Object.entries(vote.automation.reminders).map(([stage, reminder]) => (
                <small className="muted" key={stage}>
                  Score {automationSettings(vote.automation!).reminders[stage as VoteReminder].score}{" "}
                  {stage === "midpoint" ? "update" : "reminder"}:{" "}
                  {reminder.state === "accepted" || reminder.state === "applied" ? "sent" : reminder.message}
                </small>
              ))}
            {vote.messageUrl && (
              <p>
                <a className="text-button" href={vote.messageUrl} target="_blank" rel="noreferrer">
                  Open ballot in Discord ↗
                </a>
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
