"use client";

import { useRef, useState, type FormEvent } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { errorStatus, reconcileDiscordRoles, reconcileError } from "./discord-roles-api";
import {
  maxPreviewAgeMs,
  planReason,
  plural,
  roleLabels,
  timeAgo,
  type PassSummary,
  type PlanEntry,
  type RolePreview,
} from "./discord-roles-data";

function CopyDiscordId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <code className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{value}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Copy Discord user ID ${value}`}
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Discord user ID copied" : ""}
      </span>
    </span>
  );
}

function groupPlan(plan: PlanEntry[]) {
  return {
    adds: plan.filter((entry) => entry.op === "add"),
    removes: plan.filter((entry) => entry.op === "remove"),
    others: plan.filter((entry) => entry.op !== "add" && entry.op !== "remove"),
    capped: plan.length >= 100,
  };
}

function partialPreview(summary: PassSummary) {
  return summary.blocked > 0 || summary.failed > 0;
}

function announcePreview(preview: RolePreview) {
  if (preview.summary.error) return `Preview stopped early. ${preview.summary.error}`;
  const { adds, removes, capped } = groupPlan(preview.summary.plan ?? []);
  return `Preview ready: ${plural(adds.length, "role")} to add and ${plural(removes.length, "role")} to remove${capped ? ". The real run may change more than the preview lists" : ""}${partialPreview(preview.summary) ? ". Some roles or people could not be checked" : ""}.`;
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
  return (
    <section
      aria-label={title}
      className={`rounded-md border p-3 ${tone === "remove" ? "border-destructive/50 bg-destructive/5" : "bg-muted/20"}`}
    >
      <h3 className="flex items-center gap-2 font-medium">
        {title}
        <Badge variant="outline">{entries.length.toLocaleString()}</Badge>
      </h3>
      {entries.length ? (
        <ul className="mt-2 divide-y">
          {entries.map((entry, index) => (
            <li
              key={`${entry.discordUserId}:${entry.roleKind ?? ""}:${entry.op}:${index}`}
              className="grid gap-1 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <CopyDiscordId value={entry.discordUserId} />
                {entry.roleKind ? (
                  <Badge variant={tone === "remove" ? "destructive" : "secondary"}>{roleLabels[entry.roleKind]}</Badge>
                ) : null}
              </div>
              <small className="text-xs text-muted-foreground">{planReason(entry)}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

function PreviewResult({ preview }: { preview: RolePreview }) {
  const { summary } = preview;
  const { adds, removes, others, capped } = groupPlan(summary.plan ?? []);
  return (
    <section className="mt-5 grid gap-4 border-t pt-4" aria-label="Preview of role changes">
      <p className="text-sm text-muted-foreground" aria-live="off">
        Preview from{" "}
        <time dateTime={new Date(preview.at).toISOString()} title={new Date(preview.at).toLocaleString()}>
          {timeAgo(new Date(preview.at).toISOString())}
        </time>
        . A preview changes nothing in Discord.
      </p>
      {summary.error ? (
        <Alert className="border-amber-500/30 bg-amber-500/5">
          <AlertTitle>The preview did not finish</AlertTitle>
          <AlertDescription>{summary.error}</AlertDescription>
        </Alert>
      ) : null}
      {removes.length ? (
        <Alert variant="destructive">
          <AlertTitle>{plural(removes.length, "role")} would be removed</AlertTitle>
          <AlertDescription>
            Check each removal in the Remove list below before running the role check.
          </AlertDescription>
        </Alert>
      ) : null}
      {capped ? (
        <Alert className="border-amber-500/30 bg-amber-500/5">
          <AlertTitle>This preview stopped after {plural(summary.plan?.length ?? 0, "entry")}.</AlertTitle>
          <AlertDescription>The real run may change more people than are listed here.</AlertDescription>
        </Alert>
      ) : null}
      {!summary.error && summary.blocked > 0 ? (
        <Alert className="border-amber-500/30 bg-amber-500/5">
          <AlertTitle>
            {summary.blocked === 1
              ? "1 role fails its setup checks"
              : `${plural(summary.blocked, "role")} fail their setup checks`}
          </AlertTitle>
          <AlertDescription>
            Those roles are left out of this preview. Fix the setup checks above, then preview again.
          </AlertDescription>
        </Alert>
      ) : null}
      {!summary.error && summary.failed > 0 ? (
        <Alert className="border-amber-500/30 bg-amber-500/5">
          <AlertTitle>Gramps could not read {plural(summary.failed, "person", "people")} from Discord.</AlertTitle>
          <AlertDescription>This preview leaves out their roles.</AlertDescription>
        </Alert>
      ) : null}

      <dl aria-label="Preview counts" className="grid grid-cols-3 gap-2">
        <div className="rounded-md bg-muted/40 px-3 py-2">
          <dt className="text-xs text-muted-foreground">Add</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{adds.length.toLocaleString()}</dd>
        </div>
        <div
          className={`rounded-md px-3 py-2 ${removes.length ? "bg-destructive/10 text-destructive" : "bg-muted/40"}`}
        >
          <dt className="text-xs">Remove</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{removes.length.toLocaleString()}</dd>
        </div>
        <div className="rounded-md bg-muted/40 px-3 py-2">
          <dt className="text-xs text-muted-foreground">No change in Discord</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{others.length.toLocaleString()}</dd>
        </div>
      </dl>

      {summary.plan?.length ? (
        <div className="grid gap-3">
          <PlanGroup title="Add" entries={adds} tone="add" empty="No roles to add." />
          <PlanGroup title="Remove" entries={removes} tone="remove" empty="No roles to remove." />
          {others.length ? (
            <details className="rounded-md border px-3">
              <summary className="cursor-pointer py-3 text-sm font-medium">
                No change in Discord ({others.length.toLocaleString()})
              </summary>
              <div className="pb-3">
                <PlanGroup title="Noted or left as is" entries={others} tone="other" />
              </div>
            </details>
          ) : null}
        </div>
      ) : !summary.error ? (
        partialPreview(summary) ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            No changes found among the roles and people Gramps could check. See the notes above.
          </p>
        ) : (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            Nothing would change. Everyone already has the roles they have earned.
          </p>
        )
      ) : null}
    </section>
  );
}

function RunPassCounts({ summary }: { summary: PassSummary }) {
  const counts: [string, number][] = [
    ["Added", summary.added],
    ["Removed", summary.removed],
    ["Noted", summary.noted],
    ["Failed", summary.failed],
    ["Blocked", summary.blocked],
    ["Deferred", summary.deferred],
  ];
  return (
    <dl className="grid grid-cols-3 gap-2 sm:grid-cols-6">
      {counts.map(([label, value]) => (
        <div key={label} className="rounded-md bg-muted/40 px-3 py-2">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 font-semibold tabular-nums">{value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

type RunResult = { done: true; summary: PassSummary; replayed: boolean } | { done: false; message: string };
const safeRefusalStatuses = [400, 401, 403, 404, 409, 429, 503];

function RunDialog({
  csrf,
  preview,
  onClose,
  onRan,
  onSettled,
  onRunningChange,
}: {
  csrf: string;
  preview: RolePreview;
  onClose: () => void;
  onRan: () => void;
  onSettled: () => void;
  onRunningChange: (running: boolean) => void;
}) {
  const [id, setId] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [validation, setValidation] = useState("");
  const [refusal, setRefusal] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);
  const submitted = useRef(false);
  const { adds, removes, others, capped } = groupPlan(preview.summary.plan ?? []);
  const at = new Date(preview.at).toISOString();
  const reasonValue = reason.trim();
  const reasonValid =
    reasonValue.length >= 3 &&
    reasonValue.length <= 200 &&
    [...reasonValue].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending || submitted.current || result) return;
    if (!reasonValid) {
      setValidation("Enter a single-line reason between 3 and 200 characters.");
      return;
    }
    if (Date.now() - preview.at > maxPreviewAgeMs) {
      setValidation("This preview is more than 10 minutes old. Cancel, preview again, then run the role check.");
      return;
    }

    submitted.current = true;
    setSending(true);
    onRunningChange(true);
    setValidation("");
    setRefusal("");
    try {
      const response = await reconcileDiscordRoles({ csrf, id, reason: reasonValue, dryRun: false });
      setResult({ done: true, summary: response.summary, replayed: response.replayed });
      onRan();
    } catch (error) {
      if (safeRefusalStatuses.includes(errorStatus(error) ?? -1)) {
        submitted.current = false;
        setId(crypto.randomUUID());
        setRefusal(reconcileError(error, false));
      } else {
        setResult({ done: false, message: reconcileError(error, false) });
        onRan();
      }
    } finally {
      setSending(false);
      onRunningChange(false);
      onSettled();
    }
  }

  const resultTitle = result
    ? !result.done
      ? "Role check result not confirmed"
      : result.summary.error
        ? "Role check stopped early"
        : "Role check finished"
    : "Run role check now";

  return (
    <Dialog open onOpenChange={(open) => !open && !sending && onClose()}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl"
        showCloseButton={!sending}
        onEscapeKeyDown={(event) => sending && event.preventDefault()}
        onPointerDownOutside={(event) => sending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{resultTitle}</DialogTitle>
          <DialogDescription>
            {result
              ? !result.done
                ? "Refresh the page and check Recent role changes before running another role check."
                : result.summary.error
                  ? "Gramps stopped before it finished checking everyone. Any change it made before stopping is kept; the page behind this dialog shows the updated status."
                  : "Gramps finished checking everyone. The page behind this dialog shows the updated status."
              : "Gramps checks everyone now and changes roles in Discord to match. Nothing is posted in Discord and nobody is pinged."}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          {!result ? (
            <>
              <div className="grid gap-2 rounded-md border bg-muted/30 p-4 text-sm">
                <strong>
                  From the preview{" "}
                  <time dateTime={at} title={new Date(at).toLocaleString()}>
                    {timeAgo(at)}
                  </time>
                </strong>
                <span>Add: {plural(adds.length, "role")}</span>
                <span>Remove: {plural(removes.length, "role")}</span>
                <span>No change in Discord: {plural(others.length, "entry", "entries")}</span>
              </div>
              {removes.length ? (
                <Alert variant="destructive">
                  <AlertTitle>This run would remove {plural(removes.length, "role")}.</AlertTitle>
                  <AlertDescription>Make sure each removal in the preview is right before running.</AlertDescription>
                </Alert>
              ) : null}
              {capped ? (
                <Alert className="border-amber-500/30 bg-amber-500/5">
                  <AlertTitle>
                    The preview stopped after {plural(preview.summary.plan?.length ?? 0, "entry")}.
                  </AlertTitle>
                  <AlertDescription>This run may change more people than it showed.</AlertDescription>
                </Alert>
              ) : null}
              <p className="text-sm text-muted-foreground">
                Each check makes at most 50 changes and leaves the rest for a follow-up a minute later. Roles staff
                changed by hand in Discord are left alone.
              </p>
              <label className="grid gap-2 text-sm font-medium" htmlFor="discord-role-run-reason">
                Reason
                <Input
                  id="discord-role-run-reason"
                  autoFocus
                  maxLength={200}
                  value={reason}
                  onChange={(event) => setReason(event.currentTarget.value)}
                  placeholder="For example, monthly role check"
                  disabled={sending}
                  aria-invalid={Boolean(validation || refusal) || undefined}
                />
              </label>
              <p className="text-sm text-muted-foreground">This reason is recorded with the staff role check.</p>
              {validation || refusal ? (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>{validation || refusal}</AlertDescription>
                </Alert>
              ) : null}
            </>
          ) : result.done ? (
            <div className="grid gap-4">
              {result.replayed ? (
                <Alert>
                  <AlertDescription>Gramps had already run this check. This is its result.</AlertDescription>
                </Alert>
              ) : null}
              {result.summary.error ? (
                <Alert className="border-amber-500/30 bg-amber-500/5">
                  <AlertDescription>{result.summary.error}</AlertDescription>
                </Alert>
              ) : null}
              <RunPassCounts summary={result.summary} />
              {result.summary.deferred > 0 ? (
                <p className="text-sm text-muted-foreground">
                  {plural(result.summary.deferred, "person", "people")} will be checked in a follow-up in about a
                  minute.
                </p>
              ) : null}
            </div>
          ) : (
            <Alert className="border-amber-500/30 bg-amber-500/5" role="alert">
              <AlertDescription>{result.message}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={sending} onClick={onClose}>
              {result ? "Close" : "Cancel"}
            </Button>
            {!result ? (
              <Button type="submit" disabled={sending || !reasonValid}>
                {sending ? "Running role check…" : "Run role check"}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DiscordRolesPreview({
  csrf,
  busy,
  preview,
  previewing,
  error,
  previewBlocker,
  runBlocker,
  onPreview,
  onConfirm,
  confirming,
  onClose,
  onRunningChange,
  onRan,
  onRefresh,
}: {
  csrf: string;
  busy: boolean;
  preview: RolePreview | null;
  previewing: boolean;
  error: string;
  previewBlocker: string;
  runBlocker: string;
  onPreview: () => void;
  onConfirm: () => void;
  confirming: RolePreview | null;
  onClose: () => void;
  onRunningChange: (running: boolean) => void;
  onRan: () => void;
  onRefresh: () => void;
}) {
  const previewNote = "discord-roles-preview-note";
  const runNote = "discord-roles-run-note";
  return (
    <>
      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="border-b px-4 py-4 pb-4 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-1.5">
              <CardTitle>Preview and run</CardTitle>
              <CardDescription>
                Preview what Gramps would change, then run the check when it looks right.
              </CardDescription>
            </div>
            {preview ? <Badge variant="secondary">Preview ready</Badge> : null}
          </div>
        </CardHeader>
        <CardContent className="p-4 sm:p-5">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy || Boolean(previewBlocker)}
              aria-disabled={previewing || undefined}
              aria-describedby={previewBlocker ? previewNote : undefined}
              onClick={onPreview}
            >
              {previewing ? "Previewing…" : "Preview changes"}
            </Button>
            <Button
              type="button"
              disabled={busy || previewing || Boolean(runBlocker)}
              aria-describedby={runBlocker ? (runBlocker === previewBlocker ? previewNote : runNote) : undefined}
              onClick={onConfirm}
            >
              Run role check now
            </Button>
          </div>
          <p id={previewNote} className="mt-2 text-sm text-muted-foreground" role="status">
            {previewBlocker}
          </p>
          <p id={runNote} className="mt-1 text-sm text-muted-foreground" role="status">
            {runBlocker === previewBlocker ? "" : runBlocker}
          </p>
          {error ? (
            <Alert className="mt-4 border-amber-500/30 bg-amber-500/5" role="alert">
              <AlertTitle>Preview could not be completed</AlertTitle>
              <AlertDescription>
                {error}
                {preview ? " The earlier preview is still shown below." : ""}
              </AlertDescription>
            </Alert>
          ) : null}
          {previewing && !preview ? (
            <p className="mt-4 text-sm text-muted-foreground">Asking Gramps what would change…</p>
          ) : null}
          <p className="sr-only" role="status">
            {preview && !previewing && !error ? announcePreview(preview) : ""}
          </p>
          {preview ? <PreviewResult preview={preview} /> : null}
        </CardContent>
      </Card>
      {confirming ? (
        <RunDialog
          csrf={csrf}
          preview={confirming}
          onClose={onClose}
          onRan={onRan}
          onSettled={onRefresh}
          onRunningChange={onRunningChange}
        />
      ) : null}
    </>
  );
}
