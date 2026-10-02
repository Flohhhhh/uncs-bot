import type { mapVoteView } from "../../../../../src/map-votes/map-votes.types";
import type { AutomaticVoteStatus } from "../../../../../src/common/map-vote-automation";
import { selectionLabel } from "../../../../../src/common/map-labels";
import { useResource } from "../../api/use-resource";
import { Badge, Card, date } from "../../components/ui";
import { ServerLink as Link } from "../../app/server-link";

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

export function VoteResults({ data, error = "" }: { data: VoteList; error?: string }) {
  const vote =
    data.votes.find((item) => ["publishing", "open", "closing", "needs_review"].includes(item.state)) ?? data.votes[0];
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
            Vote totals could not refresh. Displayed totals are from the last successful check.
          </p>
        )}
        {!data.enabled ? (
          <p>Community voting is not enabled. The saved rotation chooses the next map.</p>
        ) : !vote ? (
          <p>No ballot has opened yet.</p>
        ) : (
          <>
            <p>
              {vote.state === "open" ? `Closes ${date(vote.closesAt)}` : vote.message}
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

export function MapVoteStatus() {
  const { data, error, loading, refresh } = useResource<VoteList>("map-votes");
  return (
    <section aria-label="Voting status">
      {data ? (
        <VoteResults data={data} error={error} />
      ) : (
        <p role="status">{error ? "Voting status could not be loaded." : "Loading voting status…"}</p>
      )}
      <div className="toolbar">
        <Link className="text-button" to="/votes">
          Voting controls & history →
        </Link>
        {error && (
          <button className="button secondary small" disabled={loading} onClick={refresh}>
            Retry votes
          </button>
        )}
      </div>
    </section>
  );
}
