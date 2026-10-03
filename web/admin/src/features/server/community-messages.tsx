import { Link, useLocation } from "react-router-dom";
import type { CommunityMessagesStatus } from "../../../../../src/common/community-messages";
import { useResource } from "../../api/use-resource";
import { Badge, Card, Empty, date } from "../../components/ui";
import { activityLink } from "../players/player-actions";

function State({ on, label }: { on: boolean; label?: string }) {
  return <Badge kind={label ? "warn" : on ? "good" : "neutral"}>{label ?? (on ? "On" : "Off")}</Badge>;
}

export function CommunityMessages() {
  const { data, error, loading, refreshing, refresh } = useResource<CommunityMessagesStatus>("community-messages");
  const location = useLocation();
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return (
    <Card
      title="Automatic messages"
      subtitle={
        data && !error
          ? data.enabled
            ? "Set in the Gramps deployment."
            : "Turned off for this deployment."
          : undefined
      }
    >
      <div className="card-body" aria-busy={loading || refreshing}>
        {error ? (
          // A failed read never shows the last known on or off states as current.
          <Empty
            title="Message status could not be loaded"
            detail="No activation state has been assumed."
            alert
            action={
              <button
                type="button"
                className="button secondary small"
                disabled={loading || refreshing}
                onClick={() => refresh()}
              >
                Retry
              </button>
            }
          />
        ) : !data ? (
          <Empty title="Loading message status…" />
        ) : (
          <>
            {data.enabled &&
              !data.workerStarted &&
              (data.welcome.enabled ||
                data.round.enabled ||
                (data.discordStatus.enabled && data.discordStatus.configured)) && (
                <p className="notice warning">
                  The message worker has not started for this server. Check the Gramps deployment.
                </p>
              )}
            <ul className="message-list" aria-label="Automatic messages">
              <li>
                <details>
                  <summary>
                    <span className="message-name">Welcome</span>
                    <State on={data.welcome.enabled} />
                    <span className="message-meta">
                      {plural(data.welcome.messages.length, "message")} · {data.welcome.delaySeconds} s delay
                    </span>
                  </summary>
                  <div className="message-body">
                    <p className="muted">
                      Sent {data.welcome.delaySeconds} s after an observed join
                      {data.welcome.messages.length > 1 ? `, at least ${data.welcome.spacingSeconds} s apart` : ""}.
                    </p>
                    <ol>
                      {data.welcome.messages.map((message, index) => (
                        <li key={index}>{message}</li>
                      ))}
                    </ol>
                  </div>
                </details>
              </li>
              <li>
                <details>
                  <summary>
                    <span className="message-name">Round notice</span>
                    <State on={data.round.enabled} />
                    <span className="message-meta">After each observed round change</span>
                  </summary>
                  <div className="message-body">
                    <p>{data.round.message}</p>
                    <p className="muted">A missed round change may skip a notice.</p>
                  </div>
                </details>
              </li>
              <li>
                <div className="message-row">
                  <span className="message-name">Discord card</span>
                  <State
                    on={data.discordStatus.enabled}
                    label={
                      data.discordStatus.enabled && !data.discordStatus.configured
                        ? "Needs channel and message"
                        : undefined
                    }
                  />
                  <span className="message-meta">Server status in Discord</span>
                </div>
              </li>
            </ul>
            <details className="message-observations">
              <summary>Activity &amp; setup</summary>
              <dl>
                <div>
                  <dt>Last server observation</dt>
                  <dd>{date(data.lastObservedAt)}</dd>
                </div>
                <div>
                  <dt>Last message acknowledged</dt>
                  <dd>{date(data.lastMessageAcknowledgedAt)}</dd>
                </div>
                <div>
                  <dt>Last Discord card update</dt>
                  <dd>{date(data.lastStatusCardUpdatedAt)}</dd>
                </div>
              </dl>
              <p className="muted">
                Times cover this Gramps process. An acknowledgment means the game accepted the message; it does not
                prove a player saw it. Change messages in the Gramps deployment.
              </p>
              <Link to={activityLink(location.search, "actions")}>View message receipts →</Link>
            </details>
          </>
        )}
      </div>
    </Card>
  );
}
