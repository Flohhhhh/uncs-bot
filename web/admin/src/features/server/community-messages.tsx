import type { CommunityMessagesStatus } from "../../../../../src/common/community-messages";
import { useResource } from "../../api/use-resource";
import { ServerLink } from "../../app/server-link";
import { Badge, Card, Empty, date } from "../../components/ui";

export function CommunityMessages() {
  const { data, error, loading, refresh } = useResource<CommunityMessagesStatus>("community-messages");
  return (
    <Card
      title="Automatic community messages"
      badge={<Badge>{error ? "STATUS UNAVAILABLE" : data?.enabled ? "CONFIGURED" : data ? "OFF" : "LOADING"}</Badge>}
    >
      <div className="card-body" aria-busy={loading}>
        <button type="button" className="button secondary small" disabled={loading} onClick={() => void refresh()}>
          Refresh message status
        </button>
        {error ? (
          <Empty
            title="Message status could not be loaded"
            detail="Refresh to try again. No activation state has been assumed."
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
            <div className="info-row">
              <span>Join welcome</span>
              <strong>{data.welcome.enabled ? "Enabled" : "Off"}</strong>
            </div>
            <details>
              <summary>
                Welcome sequence · {data.welcome.messages.length} message{data.welcome.messages.length === 1 ? "" : "s"}
              </summary>
              <p className="muted">
                Starts {data.welcome.delaySeconds}s after an observed join
                {data.welcome.messages.length > 1 ? ` · at least ${data.welcome.spacingSeconds}s between messages` : ""}
                .
              </p>
              <ol>
                {data.welcome.messages.map((message, index) => (
                  <li key={index}>{message}</li>
                ))}
              </ol>
            </details>
            <div className="info-row">
              <span>Round notice</span>
              <strong>{data.round.enabled ? "Enabled" : "Off"}</strong>
            </div>
            <details>
              <summary>Round message</summary>
              <p>{data.round.message}</p>
              <p className="muted">Sent after an observed round transition. A missed transition may skip a notice.</p>
            </details>
            <div className="info-row">
              <span>Discord status card</span>
              <strong>
                {!data.discordStatus.enabled
                  ? "Off"
                  : data.discordStatus.configured
                    ? "Enabled"
                    : "Needs channel and message"}
              </strong>
            </div>
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
                prove a player saw it.
              </p>
              <p className="muted">
                Change messages and activation in the Gramps deployment. Refresh here to check its loaded configuration.
              </p>
              <ServerLink to="/audit">View message receipts →</ServerLink>
            </details>
          </>
        )}
      </div>
    </Card>
  );
}
