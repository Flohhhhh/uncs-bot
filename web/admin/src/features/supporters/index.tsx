import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useResource } from "../../api/use-resource";
import { useAdmin } from "../../app/context";
import { Badge, Card, Empty, Modal, ReasonField, date } from "../../components/ui";
import { DataTable } from "../../components/data-table";
import {
  applicationSteamId,
  discordCell,
  discordSource,
  founderOffered,
  founderWindowLabel,
  newYork,
  patronLinkRefused,
  paymentLine,
  paymentOffered,
  providerLine,
  recordName,
  reviewInput,
  rowState,
  stateRank,
  steamSource,
  type DiscordCell,
  type RowState,
} from "./policy";
import { ManualMember } from "./manual-member";
import { PatreonImport } from "./patreon-sync";
import { AddPaypalSupporter } from "./paypal-form";
import type { Supporter, SupporterDecision, SupporterReviewResponse, SupportersResponse } from "./types";

/** Each staff action: its button label, which is also the form's title, the reason it starts with, and where it is sent. */
const decisions = {
  link: { label: "Change accounts", reason: "Accounts changed", endpoint: "link" },
  review: { label: "Keep accounts", reason: "Accounts kept", endpoint: "review" },
  payment: { label: "Add payment", reason: "Payment added", endpoint: "payment" },
  founder: { label: "Make founder", reason: "Founder confirmed", endpoint: "founder" },
} satisfies Record<SupporterDecision, { label: string; reason: string; endpoint: SupporterDecision }>;
type Decision = keyof typeof decisions;

const providerName = (record: Supporter) => (record.provider === "paypal" ? "PayPal" : "Patreon");
const day = (value: string) =>
  new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const refundWait = (record: Supporter) => record.nextSteps.some((step) => step.code === "founder_automatic_waiting");

/** The record's steps by who acts on them. Each heading shows only with something under it. */
function Steps({ record, state }: { record: Supporter; state: RowState }) {
  // The server's founder verdict, unless a step already gives it.
  const blocked = record.founderBlockedMessage;
  const verdictShown = record.nextSteps.some(
    (step) => step.message === blocked || step.code === `founder_${record.founderBlockedReason}`,
  );
  const sections: [string, string[]][] = [
    ["Needs you", state.needs],
    ["Waiting", state.waiting],
    ["Later", state.later],
    ["Not a founder", blocked && !verdictShown ? [...state.notes, blocked] : state.notes],
  ];
  return (
    <>
      {sections
        .filter(([, lines]) => lines.length > 0)
        .map(([heading, lines]) => (
          <section className="supporter-steps" key={heading}>
            <h3>{heading}</h3>
            <ul>
              {lines.map((line, index) => (
                <li key={`${index}:${line}`}>{line}</li>
              ))}
            </ul>
          </section>
        ))}
    </>
  );
}

/**
 * Four facts about the record: Discord, SteamID, payment and founder. What Patreon reports after the fact is a note
 * here, never a task: a link Patreon no longer shows is kept, and a founder stays a founder.
 */
function Facts({
  record,
  founderAuto,
  importConfigured,
}: {
  record: Supporter;
  founderAuto: boolean;
  /** The Patreon import runs, so what Patreon reports is current. */
  importConfigured: boolean;
}) {
  const payment = record.latestPayment;
  const unreported =
    importConfigured &&
    record.provider === "patreon" &&
    Boolean(record.discordId) &&
    record.discordSource === "patreon" &&
    !record.patreonDiscordId;
  const founderNote =
    record.founder?.paymentVerified === false
      ? "Patreon no longer shows their founder payment as paid. They stay a founder."
      : record.founder?.paymentFirst === false
        ? "Patreon shows an earlier payment. They stay a founder."
        : null;
  const charge =
    record.provider === "patreon" && record.lastChargeStatus && record.lastChargeStatus !== "Paid"
      ? record.lastChargeStatus
      : null;
  // Why Gramps would not make this ready record a founder itself. Only while automatic founders are on does Gramps
  // look at it at all. PayPal records are never automatic, a record waiting out the refund wait already says when
  // Gramps makes it a founder, and a record another one may share a person with already says so in its steps.
  const skipped =
    founderAuto && founderOffered(record) && record.automaticBlockedReason !== "not_patreon" && !refundWait(record)
      ? record.automaticBlockedMessage
      : null;
  return (
    <dl className="application-details supporter-facts">
      <div>
        <dt>Discord</dt>
        <dd>
          {record.discordId ? (
            <>
              {record.discordId}
              <small>{discordSource(record)}</small>
              {unreported && <small>Patreon no longer shows it.</small>}
            </>
          ) : (
            <>
              Not connected
              {record.patreonDiscordId && <small>Patreon shows {record.patreonDiscordId}.</small>}
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>SteamID</dt>
        <dd>
          {record.steamId ? (
            <>
              {record.steamId}
              <small>{steamSource(record)}</small>
            </>
          ) : (
            "None yet"
          )}
        </dd>
      </div>
      <div>
        <dt>Payment</dt>
        <dd>
          {paymentLine(payment)}
          {payment && <small>{date(payment.paidAt)}</small>}
          {charge && <small className="warning-text">Last charge: {charge}</small>}
        </dd>
      </div>
      <div>
        <dt>Founder</dt>
        <dd>
          {record.founder ? (
            <>
              Since {day(record.founder.awardedAt)}
              <small>{record.founder.automatic ? "Added by Gramps" : "Added by staff"}</small>
              {founderNote && <small>{founderNote}</small>}
            </>
          ) : (
            "No"
          )}
          {skipped && <small className="warning-text">Gramps skipped this: {skipped}</small>}
        </dd>
      </div>
    </dl>
  );
}

/**
 * The account fields. An approved application's SteamID is never filled in: staff choose to use it, and only while
 * the Discord field still holds the account that applied. The server's own SteamID step sits beside the field, so
 * staff see why a SteamID is flagged.
 */
function LinkFields({ record }: { record: Supporter }) {
  const [discordId, setDiscordId] = useState(record.discordId ?? "");
  const steamInput = useRef<HTMLInputElement>(null);
  const hint = useId();
  const offered = applicationSteamId(record);
  const steamNote = record.nextSteps.find((step) => step.area === "steam")?.message;
  // As on save, an empty Discord field keeps the current account; only a different ID is a new account.
  const typedDiscordId = discordId.trim();
  const discordChanged = typedDiscordId !== "" && typedDiscordId !== record.discordId;
  return (
    <>
      <label>
        Discord user ID
        <input
          name="discordId"
          pattern="[0-9]{17,20}"
          maxLength={20}
          inputMode="numeric"
          defaultValue={record.discordId ?? ""}
          onChange={(event) => setDiscordId(event.target.value)}
          placeholder="Discord user ID, not a display name"
        />
      </label>
      <label>
        SteamID64
        <input
          ref={steamInput}
          name="steamId"
          pattern="[0-9]{17}"
          maxLength={17}
          inputMode="numeric"
          defaultValue={record.steamId ?? ""}
          placeholder="17-digit SteamID64"
          aria-describedby={steamNote || offered ? hint : undefined}
        />
      </label>
      {(steamNote || offered) && (
        <div className="supporter-offer" id={hint}>
          {steamNote && <p className="muted">{steamNote}</p>}
          {offered &&
            (discordChanged ? (
              <p className="muted">SteamID {offered} belongs with the current Discord account.</p>
            ) : (
              <button
                type="button"
                className="button secondary small"
                onClick={() => {
                  if (!steamInput.current) return;
                  steamInput.current.value = offered;
                  steamInput.current.focus();
                }}
              >
                Use SteamID {offered}
              </button>
            ))}
        </div>
      )}
      {record.discordId && (
        <label className="supporter-check">
          <input type="checkbox" name="steamConfirmed" />
          <span>
            The SteamID belongs to the new Discord account too.
            <small>Needed when the Discord account changes and the SteamID stays.</small>
          </span>
        </label>
      )}
    </>
  );
}

function PaymentFields() {
  return (
    <>
      <div className="supporter-form-grid">
        <label>
          Paid on
          <input type="datetime-local" name="paidAt" required step={60} />
          <small>Your local time.</small>
        </label>
        <label>
          Amount (USD)
          <input type="number" name="amount" required min="0.01" step="0.01" max="1000000" placeholder="5.00" />
        </label>
      </div>
      <label>
        Patreon reference
        <input name="reference" required minLength={3} maxLength={120} autoComplete="off" />
      </label>
      <label className="supporter-check">
        <input type="checkbox" name="completedPaymentVerified" required />
        <span>I checked this payment in Patreon.</span>
      </label>
      <label className="supporter-check">
        <input type="checkbox" name="firstSuccessfulPaymentVerified" />
        <span>
          This was their first payment.
          <small>Needed to make them a founder.</small>
        </span>
      </label>
    </>
  );
}

/**
 * One supporter: what is left and who does it, four facts, and the staff actions. An action opens its form in the
 * same dialog. A save that cannot be confirmed keeps its review ID and cannot be sent again from here.
 */
function SupporterDialog({
  record: initialRecord,
  importConfigured,
  founderAuto,
  unavailable,
  onClose,
  onReviewed,
}: {
  record: Supporter;
  /** The Patreon import runs, so it brings in each Patreon payment itself. */
  importConfigured: boolean;
  /** Automatic founders are switched on. */
  founderAuto: boolean;
  unavailable: boolean;
  onClose: () => void;
  onReviewed: () => void;
}) {
  const { busy, setBusy } = useAdmin();
  const [record, setRecord] = useState(initialRecord);
  const [review, setReview] = useState<{ decision: Decision; id: string } | null>(null);
  const [result, setResult] = useState<{ saved: boolean; message: string } | null>(null);
  const [validation, setValidation] = useState("");
  const [sending, setSending] = useState(false);
  const submitted = useRef(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const fields = useRef<HTMLFieldSetElement>(null);
  const outcome = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (inFlight.current) setBusy(false);
    };
  }, [setBusy]);
  // The button that opened a form, or sent it, is gone once pressed, so focus moves to what replaced it.
  useEffect(() => {
    if (review) fields.current?.querySelector<HTMLElement>('input:not([type="hidden"]), textarea')?.focus();
  }, [review]);
  useEffect(() => {
    if (result) outcome.current?.focus();
  }, [result]);
  // Make founder, unless another record may be the same person.
  const ready = founderOffered(record);

  function choose(decision: Decision) {
    if (busy || unavailable || submitted.current || (decision === "founder" && !ready)) return;
    setReview({ decision, id: crypto.randomUUID() });
    setValidation("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!review || busy || unavailable || submitted.current) return;
    let input;
    try {
      input = reviewInput(record, review.decision, review.id, new FormData(event.currentTarget));
    } catch (error) {
      setValidation(error instanceof Error ? error.message : "Check the fields above.");
      return;
    }
    submitted.current = true;
    inFlight.current = true;
    setSending(true);
    setBusy(true);
    setValidation("");
    try {
      const response = await api<SupporterReviewResponse>(
        `supporters/${encodeURIComponent(record.id)}/${decisions[review.decision].endpoint}`,
        { method: "POST", body: JSON.stringify(input) },
      );
      if (!mounted.current) return;
      if (
        !response.ok ||
        response.supporter?.id !== record.id ||
        response.supporter.confirmKey !== record.confirmKey ||
        !Number.isInteger(response.supporter.version) ||
        response.supporter.version <= record.version
      ) {
        throw new Error("The save could not be confirmed.");
      }
      setRecord(response.supporter);
      setResult({
        saved: true,
        message: `Saved.${response.automatic?.steamFilled ? " Gramps also added their SteamID." : ""}`,
      });
    } catch (error) {
      if (!mounted.current) return;
      setResult({
        saved: false,
        message: `${error instanceof Error ? error.message : "The save could not be confirmed."} Review ID: ${review.id}`,
      });
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setSending(false);
        setBusy(false);
        onReviewed();
      }
    }
  }

  const name = recordName(record);
  const memberId = record.provider === "patreon" ? record.patreonMemberId : null;
  const selected = review ? decisions[review.decision] : null;
  const eligiblePayment = record.founderEligiblePayment;
  return (
    <Modal
      className="supporter-dialog"
      busy={sending}
      onClose={onClose}
      eyebrow={result ? null : providerName(record)}
      title={result ? (result.saved ? "Saved" : "Not sure it saved") : (selected?.label ?? name)}
      description={
        result
          ? result.saved
            ? review?.decision === "review"
              ? undefined
              : "Gramps updates their Discord roles next."
            : "Close and reload before trying again."
          : undefined
      }
    >
      <form onSubmit={submit}>
        {!result && (selected || memberId) && (
          <p className="supporter-member">{selected ? [name, memberId].filter(Boolean).join(" · ") : memberId}</p>
        )}
        {!review && (
          <>
            <Steps record={record} state={rowState(record)} />
            <Facts record={record} founderAuto={founderAuto} importConfigured={importConfigured} />
            <div className="action-list supporter-actions">
              {ready && (
                // Staff make a PayPal founder. Gramps makes a Patreon one, so for Patreon this is only an override.
                <button
                  type="button"
                  className={`button ${record.provider === "paypal" ? "primary" : "secondary"}`}
                  disabled={busy || unavailable}
                  onClick={() => choose("founder")}
                >
                  Make founder
                </button>
              )}
              <button
                type="button"
                className="button secondary"
                disabled={busy || unavailable}
                onClick={() => choose("link")}
              >
                Change accounts
              </button>
              {patronLinkRefused(record) && (
                // The record is right as it is, so the refused sign-in leaves Needs you.
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || unavailable}
                  onClick={() => choose("review")}
                >
                  Keep accounts
                </button>
              )}
              {paymentOffered(record, importConfigured) && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || unavailable}
                  onClick={() => choose("payment")}
                >
                  Add payment
                </button>
              )}
            </div>
          </>
        )}
        {review && selected && !result && (
          <>
            {review.decision === "founder" && eligiblePayment && (
              <>
                <section className="supporter-steps">
                  <h3>Payment</h3>
                  <p className="supporter-founder-payment">
                    {paymentLine(eligiblePayment)}
                    <small>{date(eligiblePayment.paidAt)}</small>
                    <small>Reference {eligiblePayment.reference}</small>
                  </p>
                </section>
                <p className="notice warning">
                  {refundWait(record) ? "This is permanent and skips the refund wait." : "This is permanent."}
                </p>
              </>
            )}
            <fieldset ref={fields} disabled={sending} className="review-fields">
              {review.decision === "link" && <LinkFields key={`link:${review.id}`} record={record} />}
              {review.decision === "payment" && <PaymentFields />}
              <ReasonField key={`reason:${review.id}`} defaultValue={selected.reason} />
            </fieldset>
            <p className="muted">
              {review.decision === "review"
                ? "The accounts stay as they are, and the refused sign-in leaves Needs you."
                : "Gramps updates their Discord roles after you save."}
            </p>
          </>
        )}
        {validation && (
          <p className="notice warning" role="alert">
            {validation}
          </p>
        )}
        {result && (
          <>
            <p ref={outcome} tabIndex={-1} className={`notice ${result.saved ? "success" : "warning"}`} role="status">
              {result.message}
            </p>
            {result.saved && <Facts record={record} founderAuto={founderAuto} importConfigured={importConfigured} />}
          </>
        )}
        <div className="dialog-footer">
          <button type="button" className="button secondary" disabled={sending} onClick={onClose}>
            {review && !result ? "Cancel" : "Close"}
          </button>
          {review && selected && !result && (
            <button type="submit" className="button primary" disabled={busy || unavailable || submitted.current}>
              {sending
                ? "Saving…"
                : review.decision === "founder" || review.decision === "review"
                  ? selected.label
                  : "Save"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

type Row = { record: Supporter; state: RowState; discord: DiscordCell };

/** The Next column: who acts, the first thing to do, and how many more. */
function NextCell({ state }: { state: RowState }) {
  const lines = state.state === "needs" ? state.needs : state.state === "waiting" ? state.waiting : [];
  return (
    <>
      <Badge kind={state.state === "needs" ? "warn" : state.state === "set" ? "good" : "neutral"}>
        {state.state === "needs" ? "Needs you" : state.state === "set" ? "All set" : "Waiting"}
      </Badge>
      {lines[0] && (
        <small className="supporter-wrap supporter-next-step">
          {lines[0]}
          {lines.length > 1 && ` +${lines.length - 1} more`}
        </small>
      )}
    </>
  );
}

type SupporterFilter = "" | "needs" | "founder";
const supporterFilters: { id: SupporterFilter; label: string; matches: (row: Row) => boolean }[] = [
  { id: "", label: "All", matches: () => true },
  { id: "needs", label: "Needs you", matches: (row) => row.state.state === "needs" },
  { id: "founder", label: "Founders", matches: (row) => Boolean(row.record.founder) },
];

function AdminSupporters() {
  const { busy } = useAdmin();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<SupporterFilter>("");
  const resource = useResource<SupportersResponse>(
    search ? `supporters?search=${encodeURIComponent(search)}` : "supporters",
  );
  const [selected, setSelected] = useState<Supporter | null>(null);
  const [adding, setAdding] = useState(false);
  const data = resource.data;
  const searchForm = (
    <form
      className="supporter-search"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || resource.loading || resource.refreshing || query.trim().length > 100) return;
        if (query.trim() === search) resource.refresh();
        else setSearch(query.trim());
      }}
    >
      <label className="search">
        <input
          type="search"
          maxLength={100}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search supporters"
          placeholder="Name or any ID"
        />
      </label>
      <button className="button secondary" disabled={busy || resource.loading || resource.refreshing}>
        Search
      </button>
      {search && (
        <button
          type="button"
          className="button secondary"
          disabled={busy || resource.loading || resource.refreshing}
          onClick={() => {
            setQuery("");
            setSearch("");
          }}
        >
          Clear
        </button>
      )}
    </form>
  );
  // A failed search keeps its form, so it can still be changed or cleared.
  if (!data)
    return (
      <>
        {search && <div className="toolbar">{searchForm}</div>}
        <Empty
          title={resource.error ? "Supporter records could not be loaded" : "Loading supporters…"}
          detail={resource.error ? "Reload to try again." : undefined}
          alert={!!resource.error}
        />
      </>
    );
  const records = data.supporters;
  const sync = data.sync;
  // Needs you first, then Waiting, then All set. The sort is stable, so the server's order holds within each.
  const rows: Row[] = records
    .map((record) => ({ record, state: rowState(record), discord: discordCell(record) }))
    .sort((a, b) => stateRank[a.state.state] - stateRank[b.state.state]);
  const shown = rows.filter((supporterFilters.find((entry) => entry.id === filter) ?? supporterFilters[0]).matches);
  const policy = data.founderPolicy;
  const automation = data.automation;
  const steamFill = Boolean(automation?.steamFill),
    founderAuto = Boolean(automation?.founderAuto);
  const exactWindow = (value: string | null) =>
    value ? new Date(value).toLocaleString(undefined, { timeZone: newYork, timeZoneName: "short" }) : "Not set";
  // Patreon must be configured for Patreon records; PayPal records stay reviewable without it.
  const patreonReady = data.enabled && data.configured;
  // While the import runs it brings in every Patreon member and payment, so staff add neither by hand.
  const importConfigured = Boolean(sync?.configured);
  const pageUnavailable = Boolean(resource.error) || resource.loading || resource.refreshing;
  const reviewUnavailable = (record: Supporter) => (record.provider === "patreon" && !patreonReady) || pageUnavailable;
  const holdHours = automation?.holdHours ?? policy.automaticHoldHours ?? 72;
  // With automatic founders off, every Patreon supporter Gramps would make a founder waits for the switch. Counted on
  // the full list only, since a search shows part of it.
  const readyOff = records.filter((record) =>
    record.nextSteps.some((step) => step.code === "founder_ready_automatic_off"),
  ).length;
  const switchNotice = !founderAuto && policy.configured && patreonReady && !search;
  const details = (
    <>
      <dl className="sync-counts">
        <div>
          <dt>Automatic founders</dt>
          <dd>{founderAuto ? "on" : "off"}</dd>
        </div>
        <div>
          <dt>SteamID fill</dt>
          <dd>{steamFill ? "on" : "off"}</dd>
        </div>
        <div>
          <dt>Refund wait</dt>
          <dd>{automation?.holdHours ?? policy.automaticHoldHours ?? 72} hours</dd>
        </div>
        <div>
          <dt>Last run</dt>
          <dd>{automation?.lastRunAt ? date(automation.lastRunAt) : "Not yet"}</dd>
        </div>
        <div>
          {/* The server knows only that the signing secret is set, not that Patreon delivers to it. */}
          <dt>Webhook</dt>
          <dd>{data.webhookConfigured ? "set up" : "not set up"}</dd>
        </div>
        <div className="supporter-window">
          <dt>Founder window</dt>
          <dd>
            {policy.configured ? `${exactWindow(policy.startsAt)} until ${exactWindow(policy.endsAt)}` : "Not set"}
          </dd>
        </div>
      </dl>
      {!importConfigured && (
        <button
          type="button"
          className="button secondary small"
          disabled={busy || pageUnavailable || !patreonReady}
          onClick={() => setAdding(true)}
        >
          Add Patreon member
        </button>
      )}
    </>
  );
  return (
    <>
      {resource.error && (
        <p className="notice warning" role="alert">
          Could not refresh, so reload before saving.
        </p>
      )}
      {automation?.lastError && (
        <p className="notice warning">
          <strong>Automatic matching needs attention.</strong> {automation.lastError}
          {automation.lastRunAt && ` Last attempt ${date(automation.lastRunAt)}.`}
        </p>
      )}
      {!policy.configured && <p className="notice warning">Founder dates are not set.</p>}
      {switchNotice && (
        <p className={`notice ${readyOff ? "warning" : "info"}`}>
          <strong>Automatic founders are off.</strong>{" "}
          {readyOff === 0
            ? "No Patreon supporter is ready yet."
            : readyOff === 1
              ? "1 Patreon supporter is ready to be a founder."
              : `${readyOff} Patreon supporters are ready to be founders.`}{" "}
          Turn on SUPPORTER_AUTO_FOUNDER_ENABLED in Railway and Gramps records them once each payment is {holdHours}{" "}
          hours old.
        </p>
      )}
      {sync && (
        <PatreonImport
          sync={sync}
          unavailable={Boolean(resource.error)}
          disabled={busy || resource.loading || resource.refreshing}
          onSynced={resource.refresh}
          status={
            <span>Automatic: {steamFill && founderAuto ? "on" : steamFill || founderAuto ? "partly on" : "off"}</span>
          }
          details={details}
        />
      )}
      <div className="toolbar">
        {searchForm}
        <AddPaypalSupporter
          unavailable={pageUnavailable}
          policy={policy}
          onRecorded={resource.refresh}
          onOpen={setSelected}
        />
      </div>
      {records.length >= 100 && <p className="filter-note">Showing the newest 100.</p>}
      <div className="filter-chips record-filters" role="group" aria-label="Filter supporter records">
        {supporterFilters.map((entry) => (
          <button
            type="button"
            key={entry.id || "all"}
            className="filter-chip"
            aria-pressed={filter === entry.id}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label} <span className="chip-count">{rows.filter(entry.matches).length}</span>
          </button>
        ))}
      </div>
      <Card title="Supporters" subtitle={founderWindowLabel(policy)}>
        {shown.length ? (
          <DataTable
            label="Supporters"
            rows={shown}
            defaultOrder="Needs you first"
            columns={[
              {
                label: "Supporter",
                value: (row) => recordName(row.record),
                sortLabels: { ascending: "Name A to Z", descending: "Name Z to A" },
              },
              {
                label: "Discord",
                value: (row) => row.discord.rank,
                sortLabels: { ascending: "Discord problems first", descending: "Discord problems last" },
              },
              {
                label: "Next",
                value: (row) => stateRank[row.state.state],
                // Needs you first is already the default order.
                sortLabels: { ascending: null, descending: "All set first" },
              },
              { label: "Open", hideLabel: true },
            ]}
            renderRow={({ record, state, discord }) => {
              const line = providerLine(record);
              return (
                <tr key={record.id}>
                  <td>
                    <strong>{recordName(record)}</strong> {record.founder && <Badge kind="good">Founder</Badge>}
                    <small className={line.warn ? "warning-text" : undefined}>{line.text}</small>
                  </td>
                  <td>
                    {discord.warn ? <Badge kind="warn">{discord.text}</Badge> : discord.text}
                    {discord.detail && <small>{discord.detail}</small>}
                  </td>
                  <td className="wide">
                    <NextCell state={state} />
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="button secondary small"
                        aria-label={`Open ${recordName(record)}`}
                        disabled={busy || resource.loading || resource.refreshing}
                        onClick={() => setSelected(record)}
                      >
                        Open
                      </button>
                    </div>
                  </td>
                </tr>
              );
            }}
          />
        ) : (
          <Empty
            title={search || filter ? "No matching supporters" : "No supporters yet."}
            detail={
              search || filter ? "Try another name, account ID or filter." : "They appear after the next Patreon sync."
            }
          />
        )}
      </Card>
      {selected && (
        <SupporterDialog
          record={selected}
          importConfigured={importConfigured}
          founderAuto={founderAuto}
          unavailable={reviewUnavailable(selected)}
          onClose={() => setSelected(null)}
          onReviewed={() => {
            void resource.refresh();
          }}
        />
      )}
      {adding && (
        <ManualMember
          unavailable={!patreonReady || pageUnavailable}
          onClose={() => setAdding(false)}
          onRecorded={resource.refresh}
        />
      )}
    </>
  );
}

export function SupportersPage() {
  const { me } = useAdmin();
  return me.role === "admin" ? (
    <AdminSupporters key={`${me.id}:${me.csrf}`} />
  ) : (
    <Empty title="Administrator access required" />
  );
}
