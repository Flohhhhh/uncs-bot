import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { assignedFaction } from "../../../../../src/common/faction-colors";
import { roundStamp, sameRound } from "../../../../../src/common/game-round";
import { useGameApi } from "../../api/server-client";
import type { ActionResult, Overview, Player } from "../../api/types";
import { validateOverview } from "../../api/validation";
import { useGameAdmin as useAdmin } from "../../app/context";
import { Badge, Modal, OutcomeBadge, Table } from "../../components/ui";
import { allowed, errorMessage, rejectionState } from "../actions/policy";
import { ActionReceipt } from "../actions/action-receipt";
import { FactionOptions, liveFactions, playerFaction } from "./factions";

type ItemState = ActionResult["state"] | "queued" | "sending" | "skipped" | "unmatched" | "refused";
export type TeamItem = {
  id: string;
  steamId: string;
  name: string;
  from: string;
  fromLabel: string;
  state: ItemState;
  message: string;
};
export type TeamMoveResult = { label: string; items: TeamItem[]; stopped: boolean };
const localLabels = {
  queued: "Not sent",
  sending: "Sending…",
  skipped: "Already on team",
  unmatched: "Skipped · roster changed",
  refused: "Skipped · roster changed",
} as const;

const isLocal = (state: ItemState): state is keyof typeof localLabels => Object.hasOwn(localLabels, state);
/** A server-refused move ("refused") reads as the dialog's own roster skip but keeps the server's receipt. */
const hasReceipt = (state: ItemState) => !isLocal(state) || state === "refused";
function ItemOutcome({ state }: { state: ItemState }) {
  return isLocal(state) ? (
    <Badge kind={state === "queued" || state === "skipped" ? "neutral" : "warn"}>{localLabels[state]}</Badge>
  ) : (
    <OutcomeBadge state={state} />
  );
}
/** No move reached the game for this player: the batch stopped first, or their roster entry changed. */
export function notSent(item: TeamItem) {
  return item.state === "queued" || item.state === "unmatched" || item.state === "refused";
}

/**
 * The pause before the next move, at least 2.2 s. A move costs about seven game requests (the roster read
 * before it, then the server's own reads around the change), so a batch keeps to half of the game's
 * advertised allowance and leaves the rest for the staff-alerts and community workers that share it.
 */
function moveSpacing(live: Overview) {
  const allowance = live.capabilities.limits?.maxRequestsPerMinutePerIp;
  return Math.max(2200, allowance ? Math.ceil((60_000 * 7) / (allowance / 2)) : 0);
}

export function TeamResults({ items }: { items: TeamItem[] }) {
  return (
    <Table headers={["Player", "Outcome", "Details"]} label="Team move outcomes" scrollable>
      {items.map((item) => (
        <tr key={item.id}>
          <td>
            <strong>{item.name}</strong>
            <small>{item.steamId}</small>
          </td>
          <td>
            <ItemOutcome state={item.state} />
          </td>
          <td className="audit-detail">
            {item.message}
            {hasReceipt(item.state) && <ActionReceipt id={item.id} />}
          </td>
        </tr>
      ))}
    </Table>
  );
}

/**
 * A single player's move reads as one line instead of a one-row table. While the dialog runs, a move that
 * is still queued is waiting on the live roster read, so the line says so rather than "Not sent".
 */
function TeamResultLine({ item, running, stopping }: { item: TeamItem; running: boolean; stopping: boolean }) {
  const checking = running && item.state === "queued";
  return (
    <div className="team-result-line" role="status" aria-label="Team move outcome">
      <p>
        {checking ? (
          <>
            <Badge kind="neutral">Checking roster…</Badge>{" "}
            {stopping ? "Stopping before the request is sent." : "Reading the live roster before sending the move."}
          </>
        ) : (
          <>
            <ItemOutcome state={item.state} /> {item.message}
          </>
        )}
      </p>
      {hasReceipt(item.state) && <ActionReceipt id={item.id} />}
    </div>
  );
}

export function TeamMoveDialog({
  players,
  initialFaction = "",
  onClose,
  onComplete,
}: {
  players: Player[];
  initialFaction?: string;
  onClose: () => void;
  onComplete?: (result: TeamMoveResult) => void;
}) {
  const admin = useAdmin();
  const api = useGameApi();
  const current = useRef(admin);
  current.current = admin;
  const mounted = useRef(true);
  const submitted = useRef(false);
  const stopRequested = useRef(false);
  const [faction, setFaction] = useState(initialFaction);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState("");
  const teams = liveFactions(admin.overview);
  const [items, setItems] = useState<TeamItem[]>(() =>
    [...new Map(players.map((player) => [player.steamId, player])).values()].map((player) => {
      const from = playerFaction(player, teams);
      return {
        id: crypto.randomUUID(),
        steamId: player.steamId,
        name: player.name,
        from: from?.name ?? "",
        fromLabel: from?.label ?? player.faction ?? "Choosing team",
        state: "queued",
        message: "Not sent",
      };
    }),
  );
  const destination = teams.find((team) => team.name === faction);
  const count = items.filter((item) => item.from !== faction).length;
  const remainingMoves = items.filter((item) => item.state === "queued" && item.from !== faction).length;
  const permitted = allowed("team", admin.me, admin.overview, admin.stale, admin.busy);
  const ready = permitted && Boolean(destination) && count > 0;
  const unavailable = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitted.current || !ready || !destination) return;
    if (
      items.some(
        (item) =>
          !admin.overview?.players.some(
            (player) => player.steamId === item.steamId && (playerFaction(player, teams)?.name ?? "") === item.from,
          ),
      )
    ) {
      setError("The reviewed roster changed. Close this review and choose the players again.");
      admin.invalidateOverview();
      return;
    }
    submitted.current = true;
    setRunning(true);
    setError("");
    admin.setBusy(true);
    const batch = items.map((item) => ({ ...item }));
    const reviewedRound = roundStamp(admin.overview!.status, Date.parse(admin.overview!.observedAt));
    let didSend = false;
    let didStop = false;
    let stopReason = "";
    let spacing = moveSpacing(admin.overview!);
    // Hiding the page invalidates the review, as it does for the dashboard's own snapshot.
    let hidden = document.hidden;
    const hiddenReason = "The dashboard was hidden during the moves.";
    const visibilityChanged = () => {
      hidden ||= document.hidden;
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    const publish = () => {
      if (mounted.current) setItems(batch.map((item) => ({ ...item })));
    };
    try {
      for (const item of batch) {
        if (didSend && item.from !== faction) await new Promise((resolve) => setTimeout(resolve, spacing));
        if (stopRequested.current || !mounted.current || hidden) {
          if (hidden) stopReason = hiddenReason;
          didStop = true;
          break;
        }
        if (item.from === faction) {
          item.state = "skipped";
          item.message = "Already on the chosen team in the reviewed roster. No request sent.";
          publish();
          continue;
        }
        // The open dialog pauses the dashboard's roster polling, so read the live roster before every move
        // instead of trusting a snapshot that only expires because of that pause.
        let live: Overview;
        try {
          live = validateOverview(await api<Overview>("overview"));
        } catch {
          stopReason = "The live roster could not be read before the next move.";
          didStop = true;
          break;
        }
        spacing = moveSpacing(live);
        const liveTeams = liveFactions(live);
        const liveRound = roundStamp(live.status, Date.parse(live.observedAt));
        if (
          stopRequested.current ||
          !mounted.current ||
          hidden ||
          !allowed("team", current.current.me, live, false, false) ||
          !liveTeams.some((team) => team.name === faction)
        ) {
          if (hidden) stopReason = hiddenReason;
          didStop = true;
          break;
        }
        if (reviewedRound && (!liveRound || !sameRound(reviewedRound, liveRound))) {
          stopReason = "The round changed during the moves.";
          didStop = true;
          break;
        }
        const livePlayer = live.players.find((player) => player.steamId === item.steamId);
        if (!livePlayer || (playerFaction(livePlayer, liveTeams)?.name ?? "") !== item.from) {
          item.state = "unmatched";
          item.message = livePlayer
            ? "Changed team after the review. No request sent."
            : "Left the server after the review. No request sent.";
          publish();
          continue;
        }
        item.state = "sending";
        item.message = "Waiting for the game’s response.";
        publish();
        didSend = true;
        try {
          const result = await api<ActionResult>("actions", {
            method: "POST",
            body: JSON.stringify({
              id: item.id,
              action: "team",
              steamId: item.steamId,
              confirm: item.steamId,
              faction,
              // Sent only when the server reads the same team from the roster, so a color format the
              // dashboard accepts and the server does not can never refuse the move.
              ...(assignedFaction(livePlayer.faction, live.status.factionScores) === item.from
                ? { expectedFaction: item.from }
                : {}),
              ...(reviewedRound ? { expectedRound: reviewedRound } : {}),
              reason: "Staff requested team move.",
            }),
          });
          item.state = ["applied", "accepted", "pending", "failed", "unknown"].includes(result.state)
            ? result.state
            : "unknown";
          item.message = result.message || "The outcome could not be confirmed. Check Action history before repeating.";
          // The server refused before sending anything because this player left or changed team since the
          // roster read. It reads as the same skip as the dialog's own roster check, keeping the server's
          // message and receipt. A new round is refused the same way, and the next roster read stops the batch.
          if (item.state === "failed" && result.changed === false) item.state = "refused";
        } catch (failure) {
          item.state = rejectionState(failure);
          item.message = `${errorMessage(failure)} Check this action in Action history before repeating it.`;
        }
        publish();
        if (stopRequested.current || item.state === "failed" || item.state === "unknown") {
          didStop = true;
          break;
        }
      }
    } finally {
      document.removeEventListener("visibilitychange", visibilityChanged);
      current.current.setBusy(false);
      if (didStop) current.current.invalidateOverview();
      if (mounted.current) {
        setRunning(false);
        setDone(true);
        setStopped(didStop);
        onComplete?.({ label: destination.label, items: batch, stopped: didStop });
        if (didStop)
          setError(
            stopRequested.current
              ? "Stopped at your request. Sent moves keep their recorded outcomes. Refresh the roster before reviewing the remaining players."
              : `${stopReason ? `${stopReason} ` : ""}Stopped before sending the remaining requests. Review Action history and refresh the roster before a new review. Attempted players will not be retried automatically.`,
          );
        else void current.current.refresh();
      }
    }
  }

  return (
    <Modal
      serverScoped
      className="team-dialog"
      title={
        done
          ? stopped
            ? "Team move stopped"
            : "Team requests complete"
          : running
            ? "Moving players"
            : `Move ${items.length === 1 ? items[0].name : `${items.length} players`}`
      }
      description={
        (done || running) && items.length === 1
          ? `${items[0].name} to ${destination?.label ?? faction}.`
          : done || running
            ? `${destination?.label ?? faction}. Each player has their own recorded outcome. ${items.filter(notSent).length} not sent.`
            : "Review the named players and destination. This changes team assignment without sending a forced kill; players may need to respawn."
      }
      onClose={onClose}
      busy={running}
      eyebrow={done ? null : undefined}
    >
      <form onSubmit={(event) => void submit(event)}>
        {submitted.current && items.length === 1 ? (
          <TeamResultLine item={items[0]} running={running} stopping={stopped} />
        ) : submitted.current ? (
          <>
            <div className="team-progress" role="status">
              {items.filter((item) => item.state !== "queued" && item.state !== "sending").length} / {items.length}{" "}
              processed
              {running &&
                (stopped
                  ? " · stopping remaining moves. Any request already sent will finish."
                  : " · sending one at a time")}
            </div>
            <TeamResults items={items} />
          </>
        ) : (
          <>
            <label>
              Destination team
              <select name="faction" required value={faction} onChange={(event) => setFaction(event.target.value)}>
                <FactionOptions teams={teams} excluded={items.length === 1 ? items[0].from : ""} />
              </select>
            </label>
            <ul className="team-review-players">
              {items.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <small>{item.steamId}</small>
                  </div>
                  <span>
                    {item.fromLabel} → <strong>{destination?.label ?? "Choose destination"}</strong>
                    {item.from === faction && <small>Already on this team — no request will be sent</small>}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {/* The open dialog pauses polling, so the snapshot can expire during the review. Say why Move is off, in
            a region that stays in the review so screen readers announce the reason when it is filled in. */}
        {!submitted.current && (
          <div role="status" id={unavailable}>
            {!permitted && (
              <p className="notice warning">
                {admin.stale
                  ? "Server details need a fresh check. Close this dialog and refresh before moving players."
                  : "Unavailable for your role, connection, or server build. Refresh the dashboard before trying again."}
              </p>
            )}
          </div>
        )}
        {error && (
          <div className="notice warning" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          {running && remainingMoves > 0 && (
            <button
              type="button"
              className="button secondary"
              disabled={stopped}
              onClick={() => {
                stopRequested.current = true;
                setStopped(true);
              }}
            >
              {stopped ? "Stopping…" : "Stop remaining moves"}
            </button>
          )}
          {!running && (
            <button type="button" className="button secondary" onClick={onClose}>
              {done ? "Close" : "Cancel"}
            </button>
          )}
          {!submitted.current && (
            <button
              type="submit"
              className="button primary"
              disabled={!ready}
              aria-describedby={permitted ? undefined : unavailable}
            >
              Move {count} player{count === 1 ? "" : "s"}
              {destination ? ` to ${destination.label}` : ""}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
