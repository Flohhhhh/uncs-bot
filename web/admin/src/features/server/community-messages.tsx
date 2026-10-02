import { Link, useLocation } from "react-router-dom";
import type { CommunityMessagesStatus } from "../../../../../src/common/community-messages";
import { useResource } from "../../api/use-resource";
import { Badge, Card, Empty, date } from "../../components/ui";
import { activityLink } from "../players/player-actions";
import { When } from "./activity-entries";

type Welcome = CommunityMessagesStatus["welcome"];
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const seconds = (value: number) => (value >= 60 && value % 60 === 0 ? `${value / 60} min` : `${value} s`);
const time = (value: string | null | undefined) => (value && Number.isFinite(Date.parse(value)) ? value : null);

function State({ on, label }: { on: boolean; label?: string }) {
  return <Badge kind={label ? "warn" : on ? "good" : "neutral"}>{label ?? (on ? "On" : "Off")}</Badge>;
}

/**
 * One set of welcome variants. Each line of a variant is its own message, sent in order. A single variant lists its
 * messages; several are numbered, and each join gets one of them at random.
 */
function Variants({ audience, variants }: { audience?: string; variants: string[][] }) {
  const suffix = audience ? ` ${audience}` : "";
  if (variants.length === 1)
    return (
      <ol aria-label={`Welcome messages${suffix}`}>
        {variants[0].map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ol>
    );
  return (
    <>
      <p className="muted">Each join gets a random variant, never the player's previous one.</p>
      <ol className="message-variants" aria-label={`Welcome variants${suffix}`}>
        {variants.map((lines, index) => (
          <li key={index}>
            {lines.map((line, part) => (
              <span key={part} className="message-line">
                {line}
              </span>
            ))}
          </li>
        ))}
      </ol>
    </>
  );
}

/** How the whitelisted welcome learns who is on the whitelist, and whether that last worked. */
function WhitelistCheck({
  whitelist,
  welcomeOn,
}: {
  whitelist: NonNullable<Welcome["whitelist"]>;
  welcomeOn: boolean;
}) {
  const loaded = time(whitelist.lastLoadedAt);
  const failed = time(whitelist.lastFailedAt);
  // A failed read newer than the last good one sends these players the standard welcome for now.
  const failing = failed !== null && (loaded === null || Date.parse(failed) > Date.parse(loaded));
  return (
    <>
      <p className={`status-line ${failing ? "attention" : loaded ? "good" : "quiet"}`}>
        <span>
          Whitelist check: <strong>{failing ? "Last read failed" : loaded ? "Working" : "Not read yet"}</strong>
        </span>
        {failing && failed && (
          <span>
            Failed <When at={failed} />
          </span>
        )}
        {loaded ? (
          <span>
            Last read <When at={loaded} />
          </span>
        ) : (
          // The whitelist is read only to choose a welcome.
          !failing && <span>{welcomeOn ? "Reads on the next join" : "Not read while the welcome is off"}</span>
        )}
        <span>Reused for up to {seconds(whitelist.cacheSeconds)}</span>
      </p>
      <p className="muted">
        Reads the game's running whitelist (reserved slots), not the saved settings. Whitelist changes made through
        Gramps refresh it sooner.
      </p>
      {failing && <p className="muted">After a failed read, every joiner gets the standard welcome for a minute.</p>}
    </>
  );
}

function WelcomeRow({ welcome }: { welcome: Welcome }) {
  const variants = welcome.variants?.length ? welcome.variants : [welcome.messages];
  const whitelisted = welcome.whitelistedVariants?.length ? welcome.whitelistedVariants : null;
  const spaced = [...variants, ...(whitelisted ?? [])].some((lines) => lines.length > 1);
  const count =
    variants.length === 1 && !whitelisted
      ? plural(variants[0].length, "message")
      : `${plural(variants.length, "variant")}${whitelisted ? `, ${whitelisted.length} for whitelisted players` : ""}`;
  return (
    <li>
      <details>
        <summary>
          <span className="message-name">Welcome</span>
          <State on={welcome.enabled} />
          <span className="message-meta">
            {count} · {welcome.delaySeconds} s delay
          </span>
        </summary>
        <div className="message-body">
          <p className="muted">
            Sent {welcome.delaySeconds} s after an observed join
            {spaced ? `, at least ${welcome.spacingSeconds} s apart` : ""}.
          </p>
          {whitelisted ? (
            <>
              <section className="message-set">
                <h4>Everyone else</h4>
                <Variants audience="for everyone else" variants={variants} />
              </section>
              <section className="message-set">
                <h4>Players already on the whitelist</h4>
                {welcome.whitelist && <WhitelistCheck whitelist={welcome.whitelist} welcomeOn={welcome.enabled} />}
                <Variants audience="for players already on the whitelist" variants={whitelisted} />
              </section>
            </>
          ) : (
            <Variants variants={variants} />
          )}
        </div>
      </details>
    </li>
  );
}

function RoundRow({ round }: { round: CommunityMessagesStatus["round"] }) {
  const messages = round.messages?.length ? round.messages : [round.message];
  return (
    <li>
      <details>
        <summary>
          <span className="message-name">Round notice</span>
          <State on={round.enabled} />
          <span className="message-meta">
            {messages.length > 1
              ? `${plural(messages.length, "message")} · after each observed round change`
              : "After each observed round change"}
          </span>
        </summary>
        <div className="message-body">
          {messages.length > 1 ? (
            <>
              <p className="muted">Each round gets a random message, never the previous round's.</p>
              <ol aria-label="Round messages">
                {messages.map((message, index) => (
                  <li key={index}>{message}</li>
                ))}
              </ol>
            </>
          ) : (
            <p>{messages[0]}</p>
          )}
          <p className="muted">A missed round change may skip a notice.</p>
        </div>
      </details>
    </li>
  );
}

export function CommunityMessages() {
  const { data, error, loading, refresh } = useResource<CommunityMessagesStatus>("community-messages");
  const location = useLocation();
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
      <div className="card-body" aria-busy={loading}>
        {error ? (
          // A failed read never shows the last known on or off states as current.
          <Empty
            title="Message status could not be loaded"
            detail="No activation state has been assumed."
            action={
              <button type="button" className="button secondary small" disabled={loading} onClick={() => refresh()}>
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
              <WelcomeRow welcome={data.welcome} />
              <RoundRow round={data.round} />
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
