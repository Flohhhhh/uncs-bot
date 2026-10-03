import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../api/client";
import { useAdmin } from "../../app/context";
import { Badge, Card, Empty, Modal, ReasonField } from "../../components/ui";
import { CopyValue } from "../../components/data-table";
import { singleLine } from "../actions/policy";
import { ago } from "../supporters/patreon-sync";
import { errorStatus, planReason, reconcileError, roleLabels } from "./labels";
import { Moment, PassCounts, plural } from "./status-sections";
import { MAX_PLAN_ENTRIES, validateReconcile, type PassSummary, type PlanEntry } from "./types";

export const PREVIEW_REASON = "Preview from the dashboard";
/** A real run needs a preview this recent, so staff confirm what Gramps would change now. */
export const PREVIEW_MAX_AGE_MS = 10 * 60_000;
export type Preview = { at: number; summary: PassSummary };

function groupPlan(plan: PlanEntry[]) {
  return {
    adds: plan.filter((entry) => entry.op === "add"),
    removes: plan.filter((entry) => entry.op === "remove"),
    others: plan.filter((entry) => entry.op !== "add" && entry.op !== "remove"),
    capped: plan.length >= MAX_PLAN_ENTRIES,
  };
}

/** Sends one preview or real run. A fresh ID per request; the server returns the same result for a repeated ID. */
export function reconcile(id: string, reason: string, dryRun: boolean) {
  return api<unknown>("discord-roles/reconcile", {
    method: "POST",
    body: JSON.stringify(dryRun ? { id, reason, dryRun: true } : { id, reason }),
  }).then((value) => validateReconcile(value, dryRun));
}

function PlanGroup({
  title,
  entries,
  tone,
  empty = "Nobody.",
}: {
  title: string;
  entries: PlanEntry[];
  tone: "add" | "remove" | "other";
  empty?: string;
}) {
  const heading = useId();
  return (
    <section className={`roles-plan-group ${tone}`} aria-labelledby={heading}>
      <h4 id={heading}>
        {title} <span className="chip-count">{entries.length.toLocaleString()}</span>
      </h4>
      {entries.length ? (
        <ul aria-label={title}>
          {entries.map((entry, index) => (
            <li key={`${entry.discordUserId}:${entry.roleKind ?? ""}:${entry.op}:${index}`}>
              <div className="roles-plan-who">
                <CopyValue value={entry.discordUserId} label="Discord user ID" />
                {entry.roleKind && (
                  <Badge kind={tone === "remove" ? "bad" : "neutral"}>{roleLabels[entry.roleKind]}</Badge>
                )}
              </div>
              <small>{planReason(entry)}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{empty}</p>
      )}
    </section>
  );
}

export function PreviewResult({ preview }: { preview: Preview }) {
  const { summary } = preview;
  const { adds, removes, others, capped } = groupPlan(summary.plan ?? []);
  const at = new Date(preview.at).toISOString();
  return (
    <section className="roles-preview" aria-label="Preview of role changes">
      <p className="muted" aria-live="off">
        Preview from <Moment at={at}>{ago(at)}</Moment>. A preview changes nothing in Discord.
      </p>
      {summary.error && (
        <p className="notice warning">
          <strong>The preview did not finish.</strong> {summary.error}
        </p>
      )}
      {removes.length > 0 && (
        <p className="notice error roles-remove-warning">
          <strong>
            {plural(removes.length, "role")} would be removed. Removals need a careful look: check each one in the
            Remove list below before running.
          </strong>
        </p>
      )}
      {capped && (
        <p className="notice warning">
          <strong>This preview stopped at {MAX_PLAN_ENTRIES} entries.</strong> The real run may change more people than
          are listed here.
        </p>
      )}
      <dl className="sync-counts roles-plan-counts" aria-label="Preview counts">
        <div>
          <dt>Add</dt>
          <dd>{adds.length.toLocaleString()}</dd>
        </div>
        <div className={removes.length ? "roles-remove-count" : undefined}>
          <dt>Remove</dt>
          <dd>{removes.length.toLocaleString()}</dd>
        </div>
        <div>
          <dt>No change in Discord</dt>
          <dd>{others.length.toLocaleString()}</dd>
        </div>
      </dl>
      {summary.plan?.length ? (
        <>
          <PlanGroup title="Add" entries={adds} tone="add" empty="No roles to add." />
          <PlanGroup title="Remove" entries={removes} tone="remove" empty="No roles to remove." />
          {others.length > 0 && (
            <details className="status-about">
              <summary>No change in Discord ({others.length.toLocaleString()})</summary>
              <PlanGroup title="Noted or left as is" entries={others} tone="other" />
            </details>
          )}
        </>
      ) : (
        !summary.error && (
          <Empty title="Nothing would change" detail="Everyone already has the roles they have earned." />
        )
      )}
    </section>
  );
}

type RunResult = { done: true; summary: PassSummary; replayed: boolean } | { done: false; message: string };

/** The confirmation for a real run: the latest preview's counts, a required reason, then the result. */
export function RunDialog({
  preview,
  onClose,
  onRan,
  onSettled,
}: {
  preview: Preview;
  onClose: () => void;
  /** The run went through or may have: the preview no longer describes what is left to change. */
  onRan: () => void;
  onSettled: () => void;
}) {
  const { busy, setBusy } = useAdmin();
  const [id, setId] = useState(() => crypto.randomUUID());
  const [sending, setSending] = useState(false);
  const [validation, setValidation] = useState("");
  const [refusal, setRefusal] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);
  const submitted = useRef(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (inFlight.current) setBusy(false);
    };
  }, [setBusy]);
  const { adds, removes, others, capped } = groupPlan(preview.summary.plan ?? []);
  const at = new Date(preview.at).toISOString();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || submitted.current) return;
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    if (!singleLine(reason, 3)) {
      setValidation("Enter a single-line reason between 3 and 200 characters.");
      return;
    }
    submitted.current = true;
    inFlight.current = true;
    setSending(true);
    setBusy(true);
    setValidation("");
    setRefusal("");
    try {
      const response = await reconcile(id, reason, false);
      if (!mounted.current) return;
      setResult({ done: true, summary: response.summary, replayed: response.replayed });
      onRan();
    } catch (error) {
      if (!mounted.current) return;
      const status = errorStatus(error);
      if (status !== null && [400, 404, 409, 429, 503].includes(status)) {
        // Refused before any role changed. Staff can send it again; a new ID keeps it a new request.
        submitted.current = false;
        setId(crypto.randomUUID());
        setRefusal(reconcileError(error, false));
      } else {
        setResult({ done: false, message: reconcileError(error, false) });
        onRan();
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setSending(false);
        setBusy(false);
        onSettled();
      }
    }
  }

  return (
    <Modal
      className="roles-dialog"
      busy={sending}
      onClose={onClose}
      eyebrow={result ? null : undefined}
      title={result ? (result.done ? "Role check finished" : "Role check result not confirmed") : "Run role check now"}
      description={
        result
          ? result.done
            ? "Gramps finished checking everyone. The page behind this dialog now shows the updated status."
            : "Refresh the page and check Recent role changes before running another role check."
          : "Gramps checks everyone now and changes roles in Discord to match. Nothing is posted in Discord and nobody is pinged."
      }
    >
      <form onSubmit={submit}>
        {!result && (
          <>
            <div className="application-confirm roles-confirm">
              <strong>
                From the preview <Moment at={at}>{ago(at)}</Moment>
              </strong>
              <span>Add: {plural(adds.length, "role")}</span>
              <span>Remove: {plural(removes.length, "role")}</span>
              <span>No change in Discord: {plural(others.length, "entry", "entries")}</span>
            </div>
            {removes.length > 0 && (
              <p className="notice error roles-remove-warning">
                <strong>This run would remove {plural(removes.length, "role")}.</strong> Make sure each removal in the
                preview is right before running.
              </p>
            )}
            {capped && (
              <p className="notice warning">
                The preview stopped at {MAX_PLAN_ENTRIES} entries, so this run may change more than it showed.
              </p>
            )}
            <p className="muted">
              Each check makes at most 50 changes and leaves the rest for a follow-up a minute later. Roles staff
              changed by hand in Discord are left alone.
            </p>
            <fieldset disabled={sending} className="review-fields">
              <ReasonField />
            </fieldset>
          </>
        )}
        {result?.done && (
          <>
            {result.replayed && <p className="notice info">Gramps had already run this check. This is its result.</p>}
            {result.summary.error && <p className="notice warning">{result.summary.error}</p>}
            <PassCounts pass={result.summary} />
            {result.summary.deferred > 0 && (
              <p className="muted">
                {plural(result.summary.deferred, "person", "people")} will be checked in a follow-up in about a minute.
              </p>
            )}
          </>
        )}
        {result && !result.done && (
          <p className="notice warning" role="alert">
            {result.message}
          </p>
        )}
        {(validation || refusal) && (
          <p className="notice warning" role="alert">
            {validation || refusal}
          </p>
        )}
        <div className="dialog-footer">
          <button type="button" className="button secondary" disabled={sending} onClick={onClose}>
            {result ? "Close" : "Cancel"}
          </button>
          {!result && (
            <button type="submit" className="button primary" disabled={busy}>
              {sending ? "Running role check…" : "Run role check"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

export function PreviewCard({
  preview,
  previewing,
  error,
  children,
}: {
  preview: Preview | null;
  previewing: boolean;
  error: string;
  children: ReactNode;
}) {
  return (
    <Card
      title="Preview and run"
      subtitle="Preview what Gramps would change, then run the check when it looks right."
      badge={preview ? <Badge kind="info">PREVIEW READY</Badge> : undefined}
    >
      <div className="card-body">
        {children}
        {error && (
          <p className="notice warning" role="alert">
            {error}
            {preview && " The earlier preview is still shown below."}
          </p>
        )}
        {previewing && !preview && <p className="muted">Asking Gramps what would change…</p>}
        {preview && <PreviewResult preview={preview} />}
      </div>
    </Card>
  );
}
