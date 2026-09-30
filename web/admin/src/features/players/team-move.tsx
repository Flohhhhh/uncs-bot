import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import type { ActionResult, Player } from "../../api/types";
import { useAdmin } from "../../app/context";
import { Badge, Modal, ReasonField } from "../../components/ui";
import { allowed, errorMessage, rejectionState, singleLine } from "../actions/policy";
import { FactionOptions, liveFactions, playerFaction } from "./factions";

type ItemState = ActionResult["state"] | "queued" | "sending" | "skipped";
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
const labels: Record<ItemState, string> = {
  queued: "Not sent",
  sending: "Sending…",
  applied: "Assignment confirmed",
  accepted: "Accepted · not verified",
  pending: "Pending",
  failed: "Failed",
  unknown: "Unconfirmed",
  skipped: "Already on team",
};

export function TeamResults({ items }: { items: TeamItem[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>PLAYER</th>
            <th>OUTCOME</th>
            <th>DETAILS</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <strong>{item.name}</strong>
                <small>{item.steamId}</small>
              </td>
              <td>
                <Badge
                  kind={
                    item.state === "applied"
                      ? "good"
                      : item.state === "failed"
                        ? "bad"
                        : ["unknown", "pending", "sending"].includes(item.state)
                          ? "warn"
                          : "neutral"
                  }
                >
                  {labels[item.state]}
                </Badge>
              </td>
              <td className="audit-detail">
                {item.message}
                {!["queued", "skipped"].includes(item.state) && <small>Action {item.id}</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  const current = useRef(admin);
  current.current = admin;
  const mounted = useRef(true);
  const submitted = useRef(false);
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
  const ready = allowed("team", admin.me, admin.overview, admin.stale, admin.busy) && Boolean(destination) && count > 0;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitted.current || !ready || !destination) return;
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    if (!singleLine(reason, 3)) {
      setError("Enter a single-line reason between 3 and 200 characters.");
      return;
    }
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
    let didSend = false;
    let didStop = false;
    const publish = () => {
      if (mounted.current) setItems(batch.map((item) => ({ ...item })));
    };
    try {
      for (const item of batch) {
        if (didSend && item.from !== faction) await new Promise((resolve) => setTimeout(resolve, 2200));
        const latest = current.current;
        const latestTeams = liveFactions(latest.overview);
        const latestPlayer = latest.overview?.players.find((player) => player.steamId === item.steamId);
        if (
          !mounted.current ||
          !allowed("team", latest.me, latest.overview, latest.stale, false) ||
          !latestTeams.some((team) => team.name === faction) ||
          !latestPlayer ||
          (playerFaction(latestPlayer, latestTeams)?.name ?? "") !== item.from
        ) {
          didStop = true;
          break;
        }
        if (item.from === faction) {
          item.state = "skipped";
          item.message = "Already on the chosen team in the reviewed roster. No request sent.";
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
              reason,
            }),
          });
          item.state = ["applied", "accepted", "pending", "failed", "unknown"].includes(result.state)
            ? result.state
            : "unknown";
          item.message = result.message || "The outcome could not be confirmed. Check Action history before repeating.";
        } catch (failure) {
          item.state = rejectionState(failure);
          item.message = `${errorMessage(failure)} Check this action in Action history before repeating it.`;
        }
        publish();
        if (item.state === "failed" || item.state === "unknown") {
          didStop = true;
          break;
        }
      }
    } finally {
      current.current.setBusy(false);
      if (didStop) current.current.invalidateOverview();
      if (mounted.current) {
        setRunning(false);
        setDone(true);
        setStopped(didStop);
        onComplete?.({ label: destination.label, items: batch, stopped: didStop });
        if (didStop)
          setError(
            "Stopped before sending the remaining requests. Review Action history and refresh the roster before a new review. Attempted players will not be retried automatically.",
          );
        else void current.current.refresh();
      }
    }
  }

  return (
    <Modal
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
        done || running
          ? `${destination?.label ?? faction}. Each player has their own recorded outcome. ${items.filter((item) => item.state === "queued").length} not sent.`
          : "Review the named players and destination. This changes team assignment without sending a forced kill; players may need to respawn."
      }
      onClose={onClose}
      busy={running}
    >
      <form onSubmit={(event) => void submit(event)}>
        {submitted.current ? (
          <>
            <div className="team-progress" role="status">
              {items.filter((item) => item.state !== "queued" && item.state !== "sending").length} / {items.length}{" "}
              processed{running && " · sending one at a time"}
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
            <ReasonField defaultValue="Staff-assisted team move to group players together." />
          </>
        )}
        {error && (
          <div className="notice warning" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={running}>
            {done ? "Close" : "Cancel"}
          </button>
          {!submitted.current && (
            <button type="submit" className="button primary" disabled={!ready}>
              Move {count} player{count === 1 ? "" : "s"}
              {destination ? ` to ${destination.label}` : ""}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
