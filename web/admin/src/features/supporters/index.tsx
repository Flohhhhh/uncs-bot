import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useResource } from "../../api/use-resource";
import { useAdmin } from "../../app/context";
import { Badge, Card, Empty, Modal, ReasonField, date } from "../../components/ui";
import { CopyValue, DataTable } from "../../components/data-table";
import {
  accountsToMatch,
  applicationSteamId,
  automaticPreview,
  discordDescription,
  founderReady,
  founderWindowLabel,
  identityLabels,
  matchSummary,
  newYork,
  paymentDescription,
  readyForStaff,
  reviewInput,
  steamCandidateNote,
  steamDescription,
  stepGroups,
} from "./policy";
import { ManualMember } from "./manual-member";
import { PatreonImport } from "./patreon-sync";
import type {
  AutomationStatus,
  Supporter,
  SupporterDecision,
  SupporterReviewResponse,
  SupportersResponse,
} from "./types";

const decisions = {
  link: {
    title: "Match supporter accounts",
    description:
      "Link the Discord account and SteamID64 that belong to this supporter. Only a value you change is saved, as a staff link; it does not authenticate either account.",
  },
  payment: {
    title: "Record a checked payment",
    description:
      "Check the completed payment in Patreon first. Membership status, tier price, and a screenshot alone do not establish receipt of funds.",
  },
  founder: {
    title: "Record founder promise",
    description:
      "Record the permanent standard whitelist promise against this checked payment. The benefit remains inactive until the game update and a separate release decision.",
  },
  review: {
    title: "Mark observation reviewed",
    description:
      "Record that you reviewed this membership observation. This does not verify payment or grant a benefit.",
  },
};

/**
 * A founder award, a Discord link or a checked payment can change who should hold the Founder or Supporter role, so
 * the server queues a Discord role check after saving one while Discord roles are switched on. Marking an observation
 * reviewed changes no role.
 */
const checksRoles = (decision: SupporterDecision) => decision !== "review";

const recordName = (record: Supporter) =>
  record.displayName || (record.provider === "paypal" ? "PayPal supporter" : "Patreon member");
const recordReference = (record: Supporter) =>
  record.provider === "paypal" ? "PayPal supporter" : `Member ${record.patreonMemberId}`;

function SupporterBadge({ record }: { record: Supporter }) {
  const labels: Record<string, string> = {
    active_patron: "Active membership",
    declined_patron: "Payment issue",
    former_patron: "Former member",
  };
  if (record.provider === "paypal") return <Badge>PayPal</Badge>;
  return (
    <Badge kind={record.patronStatus === "declined_patron" ? "warn" : "neutral"}>
      {(record.patronStatus && labels[record.patronStatus]) || record.patronStatus || "Status not supplied"}
    </Badge>
  );
}

function NextSteps({ record }: { record: Supporter }) {
  const { payment, notes, other } = stepGroups(record.nextSteps);
  if (!record.nextSteps.length) return null;
  return (
    <div className="supporter-steps">
      {notes.length > 0 && (
        <>
          <h3>Founder promise</h3>
          <ul>
            {notes.map((step) => (
              <li key={step.code}>{step.message}</li>
            ))}
          </ul>
        </>
      )}
      {other.length + payment.length > 0 && <h3>Still needed</h3>}
      {other.length > 0 && (
        <ul>
          {other.map((step) => (
            <li key={step.code}>{step.message}</li>
          ))}
        </ul>
      )}
      {payment.length > 0 && (
        <>
          <h4>Payment needs checking</h4>
          <ul>
            {payment.map((step) => (
              <li key={step.code}>{step.message}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SupporterDetails({ record }: { record: Supporter }) {
  const payment = record.latestPayment;
  return (
    <>
      <div className="application-identity">
        <div>
          <span className="eyebrow">
            {record.provider === "paypal" ? "PAYPAL SUPPORTER RECORD" : "PATREON MEMBER RECORD"}
          </span>
          <strong>{recordName(record)}</strong>
          <small>{record.provider === "paypal" ? "Recorded by staff from PayPal" : record.patreonMemberId}</small>
        </div>
        <SupporterBadge record={record} />
      </div>
      <dl className="application-details">
        <div>
          <dt>Record timestamp</dt>
          <dd>
            {date(record.observedAt)}
            <small>
              {record.reviewState === "verified"
                ? "Reviewed by staff; this is not payment or account ownership verification."
                : record.reviewState === "unverified"
                  ? "Entered by staff; membership status and payment need separate review."
                  : "Awaiting staff review."}
            </small>
          </dd>
        </div>
        {record.provider === "patreon" && (
          <div>
            <dt>Latest charge status</dt>
            <dd>
              {record.lastChargeStatus || "Not supplied"}
              <small>{date(record.lastChargeAt)}</small>
            </dd>
          </div>
        )}
        <div>
          <dt>Discord account</dt>
          <dd>
            {record.discordId || "Not linked"}
            <small>{discordDescription(record)}</small>
          </dd>
        </div>
        <div>
          <dt>SteamID64</dt>
          <dd>
            {record.steamId || "Not linked"}
            <small>{steamDescription(record)}</small>
            {record.match.sourceApplicationRevoked && (
              <small className="warning-text">
                The application it was copied from is no longer approved. The SteamID was kept; check it.
              </small>
            )}
          </dd>
        </div>
        <div>
          <dt>Payment evidence</dt>
          <dd>
            {paymentDescription(payment)}
            {payment && (
              <>
                <small>{date(payment.paidAt)}</small>
                <small>Reference: {payment.reference || "Not recorded"}</small>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Permanent founder record</dt>
          <dd>
            {record.founder ? (
              <>
                Recorded {date(record.founder.awardedAt)}
                <small>{record.founder.automatic ? "Recorded automatically by Gramps." : "Recorded by staff."}</small>
                <small>
                  Lifetime standard whitelist promise. Awaiting the game’s queue-tier update; no access activated.
                </small>
              </>
            ) : (
              "Not recorded"
            )}
          </dd>
        </div>
      </dl>
      <NextSteps record={record} />
    </>
  );
}

function SupporterReview({
  record: initialRecord,
  unavailable,
  onClose,
  onReviewed,
}: {
  record: Supporter;
  unavailable: boolean;
  onClose: () => void;
  onReviewed: () => void;
}) {
  const { busy, setBusy } = useAdmin();
  const [record, setRecord] = useState(initialRecord);
  const [review, setReview] = useState<{ decision: SupporterDecision; id: string } | null>(null);
  const [result, setResult] = useState<{ saved: boolean; message: string } | null>(null);
  const [validation, setValidation] = useState("");
  const [sending, setSending] = useState(false);
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
  const ready = founderReady(record);

  function choose(decision: SupporterDecision) {
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
      setValidation(error instanceof Error ? error.message : "Check the required review fields.");
      return;
    }
    submitted.current = true;
    inFlight.current = true;
    setSending(true);
    setBusy(true);
    setValidation("");
    try {
      const response = await api<SupporterReviewResponse>(
        `supporters/${encodeURIComponent(record.id)}/${review.decision}`,
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
        throw new Error("The saved record could not be confirmed. Refresh before another review.");
      }
      setRecord(response.supporter);
      setResult({
        saved: true,
        message: `Supporter review recorded.${
          response.automatic?.steamFilled
            ? " Gramps also copied the SteamID from this Discord account’s approved whitelist application."
            : ""
        } Review ID: ${review.id}`,
      });
    } catch (error) {
      if (!mounted.current) return;
      setResult({
        saved: false,
        message: `${error instanceof Error ? error.message : "The saved record could not be confirmed."} Review ID: ${review.id}`,
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

  const selected = review ? decisions[review.decision] : null;
  const eligiblePayment = record.founderEligiblePayment;
  const offeredSteamId = applicationSteamId(record);
  const candidateNote = steamCandidateNote(record);
  const steamHint = useId();
  return (
    <Modal
      className="supporter-dialog"
      busy={sending}
      onClose={onClose}
      eyebrow={result ? null : undefined}
      title={
        result
          ? result.saved
            ? "Supporter record saved"
            : "Save result not confirmed"
          : (selected?.title ?? "Supporter record")
      }
      description={
        result
          ? result.saved
            ? review && checksRoles(review.decision)
              ? "Your review has been recorded. No game access was changed. With Discord roles switched on, Gramps checks the linked Discord account’s roles next."
              : "Your review has been recorded. No game access or Discord role was changed."
            : "Close this record and refresh to check what was saved before submitting another review."
          : (selected?.description ??
            "Review account matching and payment evidence before recording any future benefit.")
      }
    >
      <form onSubmit={submit}>
        <SupporterDetails record={record} />
        {!review && (
          <div className="supporter-next">
            <h3>Actions</h3>
            <div className="action-list">
              <button
                type="button"
                className="button secondary small"
                disabled={busy || unavailable}
                onClick={() => choose("link")}
              >
                {record.identityState === "unlinked" ? "Match accounts" : "Review account match"}
              </button>
              {record.provider === "patreon" && (
                <button
                  type="button"
                  className="button secondary small"
                  disabled={busy || unavailable}
                  onClick={() => choose("payment")}
                >
                  Record checked payment
                </button>
              )}
              <button
                type="button"
                className="button secondary small"
                disabled={busy || unavailable}
                onClick={() => choose("review")}
              >
                Mark observation reviewed
              </button>
              <button
                type="button"
                className="button primary small"
                disabled={busy || unavailable || !ready}
                title={ready ? undefined : (record.founderBlockedMessage ?? undefined)}
                onClick={() => choose("founder")}
              >
                {record.founder ? "Founder promise recorded" : "Record founder promise"}
              </button>
            </div>
          </div>
        )}
        {review && selected && !result && (
          <>
            {review.decision === "founder" && eligiblePayment && (
              <div className="notice">
                <strong>Payment supporting this founder promise</strong>
                <br />
                {paymentDescription(eligiblePayment)}
                <br />
                {date(eligiblePayment.paidAt)}
                <br />
                Reference: {eligiblePayment.reference}
              </div>
            )}
            <fieldset disabled={sending} className="review-fields">
              {review.decision === "link" && (
                <>
                  <label>
                    Discord user ID
                    <input
                      name="discordId"
                      pattern="[0-9]{17,20}"
                      maxLength={20}
                      inputMode="numeric"
                      defaultValue={record.discordId ?? ""}
                      placeholder="Discord user ID, not a display name"
                    />
                  </label>
                  <label>
                    SteamID64
                    <input
                      name="steamId"
                      pattern="[0-9]{17}"
                      maxLength={17}
                      inputMode="numeric"
                      defaultValue={record.steamId ?? offeredSteamId ?? ""}
                      placeholder="17-digit SteamID64"
                      aria-describedby={offeredSteamId || candidateNote ? steamHint : undefined}
                    />
                  </label>
                  {offeredSteamId ? (
                    <p className="muted" id={steamHint}>
                      Filled in from this Discord account’s approved whitelist application. Check it belongs to this
                      supporter before saving.
                    </p>
                  ) : (
                    candidateNote && (
                      <p className="muted" id={steamHint}>
                        Not filled in. {candidateNote}
                      </p>
                    )
                  )}
                  {record.steamSource === "application" && (
                    <label className="supporter-check">
                      <input type="checkbox" name="steamConfirmed" />
                      <span>
                        The SteamID belongs to the new Discord account too.
                        <small>
                          Needed only when you change the Discord account: this SteamID was copied from the current
                          account’s application.
                        </small>
                      </span>
                    </label>
                  )}
                  <p className="muted">Leave a field as it is to keep it. Only changed values are saved.</p>
                </>
              )}
              {review.decision === "payment" && (
                <>
                  <div className="supporter-form-grid">
                    <label>
                      Completed payment date and time
                      <input type="datetime-local" name="paidAt" required step={60} />
                      <small>
                        Your local timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Recorded as UTC.
                      </small>
                    </label>
                    <label>
                      Gross completed amount · USD
                      <input
                        type="number"
                        name="amount"
                        required
                        min="0.01"
                        step="0.01"
                        max="1000000"
                        placeholder="5.00"
                      />
                    </label>
                  </div>
                  <label>
                    Patreon payment reference
                    <input
                      name="reference"
                      required
                      minLength={3}
                      maxLength={120}
                      autoComplete="off"
                      placeholder="Reference from the completed Patreon payment"
                    />
                  </label>
                  <label className="supporter-check">
                    <input type="checkbox" name="completedPaymentVerified" required />
                    <span>I checked this completed payment in Patreon and matched it to this member.</span>
                  </label>
                  <label className="supporter-check">
                    <input type="checkbox" name="firstSuccessfulPaymentVerified" />
                    <span>
                      I checked Patreon history and confirmed this was their first successful payment.
                      <small>Optional for recording a renewal. Required for founder eligibility.</small>
                    </span>
                  </label>
                </>
              )}
              <ReasonField key={review.id} />
            </fieldset>
            <div className="application-confirm">
              <strong>{selected.title}</strong>
              <span>
                {record.provider === "paypal"
                  ? `PayPal supporter ${recordName(record)}`
                  : `Patreon member ${record.patreonMemberId}`}
              </span>
              <span>
                {checksRoles(review.decision)
                  ? "This records staff evidence only and changes no game access. With Discord roles switched on, Gramps then checks the linked Discord account’s roles."
                  : "This records staff evidence only. No game or Discord access changes."}
              </span>
            </div>
          </>
        )}
        {validation && (
          <p className="notice warning" role="alert">
            {validation}
          </p>
        )}
        {result && (
          <p className={`notice ${result.saved ? "success" : "warning"}`} role="status">
            {result.message}
          </p>
        )}
        <div className="dialog-footer">
          <button type="button" className="button secondary" disabled={sending} onClick={onClose}>
            {review && !result ? "Cancel" : "Close"}
          </button>
          {review && !result && (
            <button type="submit" className="button primary" disabled={busy || unavailable || submitted.current}>
              {sending ? "Saving record…" : "Save reviewed record"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

/** Which automatic matching is switched on, as one status line. Both switches are off by default. */
function AutomationStatusLine({ automation }: { automation: AutomationStatus | undefined }) {
  const steamFill = Boolean(automation?.steamFill),
    founderAuto = Boolean(automation?.founderAuto);
  const hold = automation?.holdHours ?? 72;
  // Automatic matching only reads Patreon records, so nothing runs while Patreon is not configured.
  const idle = (steamFill || founderAuto) && automation?.configured === false;
  return (
    <div className="status-row supporter-automation">
      <p className={`status-line ${idle ? "attention" : steamFill || founderAuto ? "good" : "quiet"}`}>
        <span>
          Automatic matching:{" "}
          <strong>{steamFill && founderAuto ? "on" : steamFill || founderAuto ? "partly on" : "off"}</strong>
        </span>
        <span>SteamID fill {steamFill ? "on" : "off"}</span>
        <span>Automatic founders {founderAuto ? "on" : "off"}</span>
      </p>
      <p className="muted">
        {idle && "Patreon is not configured, so nothing is matched automatically. "}
        {founderAuto
          ? `Gramps records a Patreon founder promise itself only when the Discord account came from Patreon, a SteamID with nothing to check is linked, and the first Patreon payment qualifies and has stood for ${hold} hours. Staff record every other founder promise the founder rule allows.`
          : "Automatic founder recording is off. Records marked “Would be recorded automatically” show what it would record; staff record founder promises."}
        {steamFill
          ? " Gramps copies an empty SteamID on a Patreon record from the Discord account’s approved whitelist application when nothing about it needs checking."
          : " SteamIDs are linked by staff; a SteamID that is safe to copy from an approved application is filled in for checking."}
      </p>
    </div>
  );
}

type SupporterFilter = "" | "review" | "unlinked" | "staff" | "preview" | "automatic" | "founder";
const supporterFilters: { id: SupporterFilter; label: string; matches: (record: Supporter) => boolean }[] = [
  { id: "", label: "All", matches: () => true },
  { id: "review", label: "Awaiting review", matches: (record) => record.reviewState !== "verified" },
  { id: "unlinked", label: "Accounts to match", matches: accountsToMatch },
  { id: "staff", label: "Ready for staff", matches: readyForStaff },
  { id: "preview", label: "Would be recorded automatically", matches: automaticPreview },
  { id: "automatic", label: "Recorded automatically", matches: (record) => Boolean(record.founder?.automatic) },
  { id: "founder", label: "Founder promises", matches: (record) => !!record.founder },
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
          aria-label="Search all supporter records"
          placeholder="Name, Patreon member ID, PayPal transaction ID, Discord ID or SteamID"
        />
      </label>
      <button className="button secondary" disabled={busy || resource.loading || resource.refreshing}>
        Search all records
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
          Clear search
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
          detail={resource.error ? "Refresh to try again. No empty list has been assumed." : undefined}
          alert={!!resource.error}
        />
      </>
    );
  const records = data.supporters;
  const rows = records.filter((supporterFilters.find((entry) => entry.id === filter) ?? supporterFilters[0]).matches);
  const policy = data.founderPolicy;
  const exactWindow = (value: string | null) =>
    value ? new Date(value).toLocaleString(undefined, { timeZone: newYork, timeZoneName: "short" }) : "Not set";
  // Patreon must be configured for Patreon records; PayPal records stay reviewable without it.
  const patreonReady = data.enabled && data.configured;
  const pageUnavailable = Boolean(resource.error) || resource.loading || resource.refreshing;
  const reviewUnavailable = (record: Supporter) => (record.provider === "patreon" && !patreonReady) || pageUnavailable;
  return (
    <>
      <div className="supporter-summary">
        <p>
          Records only. Grants no game access; with Discord roles switched on, the Founder and Supporter roles follow
          these records. A membership is not a verified payment.
        </p>
        <span
          className={`pill ${policy.configured ? "neutral" : "warn"}`}
          title={
            policy.configured
              ? `${exactWindow(policy.startsAt)} until ${exactWindow(policy.endsAt)}, end not included. Use the completed payment date, not the date a membership appeared here.`
              : "Set the launch dates before any founder promise can be recorded."
          }
        >
          {founderWindowLabel(policy)}
        </span>
        {!patreonReady && <Badge kind="warn">Patreon not configured</Badge>}
        <span
          className="muted"
          title={
            data.webhookConfigured
              ? "Check delivery in Patreon."
              : "Verified member details can be entered by hand when records are ready."
          }
        >
          {/* The server knows only that the signing secret is set, not that Patreon delivers to it. */}
          Patreon webhook {data.webhookConfigured ? "set up" : "not set up"}
        </span>
      </div>
      {data.sync && (
        <PatreonImport
          sync={data.sync}
          unavailable={Boolean(resource.error)}
          disabled={busy || resource.loading || resource.refreshing}
          onSynced={resource.refresh}
        />
      )}
      <AutomationStatusLine automation={data.automation} />
      {resource.error && (
        <p className="notice warning" role="alert">
          Supporter records could not be refreshed. Refresh before recording another review.
        </p>
      )}
      <div className="toolbar">
        {searchForm}
        <button
          className="button secondary"
          disabled={busy || pageUnavailable || !patreonReady}
          onClick={() => setAdding(true)}
        >
          Record existing Patreon member
        </button>
      </div>
      <p className="filter-note">
        {search
          ? `Searching all records for “${search}”. Up to 100 matching records are shown.`
          : "Showing up to 100 recent records. Search all records to find earlier supporters."}
      </p>
      <div className="filter-chips record-filters" role="group" aria-label="Filter supporter records">
        {supporterFilters.map((entry) => (
          <button
            type="button"
            key={entry.id || "all"}
            className="filter-chip"
            aria-pressed={filter === entry.id}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label} <span className="chip-count">{records.filter(entry.matches).length}</span>
          </button>
        ))}
      </div>
      <Card
        title="Supporters"
        subtitle={`${rows.length} shown of ${records.length} loaded`}
        badge={<Badge>ADMIN ONLY</Badge>}
      >
        {rows.length ? (
          <DataTable
            label="Supporters"
            rows={rows}
            columns={[
              { label: "Supporter", value: (record) => record.displayName || record.confirmKey },
              { label: "Recurring status", value: (record) => record.patronStatus },
              { label: "Account match", value: (record) => record.identityState },
              { label: "Founder record", value: (record) => !!record.founder, firstDirection: "descending" },
              { label: "Actions" },
            ]}
            renderRow={(record) => (
              <tr key={record.id}>
                <td>
                  <strong>{recordName(record)}</strong>
                  <small>{recordReference(record)}</small>
                  <small>{record.reviewState === "verified" ? "Observation reviewed" : "Needs staff review"}</small>
                </td>
                <td>
                  <SupporterBadge record={record} />
                  {record.provider === "patreon" && (
                    <small>Latest charge: {record.lastChargeStatus || "not supplied"}</small>
                  )}
                </td>
                <td>
                  <Badge kind={accountsToMatch(record) ? "warn" : "neutral"}>
                    {identityLabels[record.identityState]}
                  </Badge>
                  <small>{matchSummary(record)}</small>
                  <small>{record.steamId ? <CopyValue value={record.steamId} /> : "SteamID not recorded"}</small>
                </td>
                <td>
                  <Badge kind={record.founder ? "good" : "neutral"}>
                    {record.founder
                      ? record.founder.automatic
                        ? "Recorded automatically"
                        : "Permanent promise"
                      : "Not recorded"}
                  </Badge>
                  {record.nextSteps[0] ? (
                    <small>
                      {record.nextSteps[0].message}
                      {record.nextSteps.length > 1 && ` (+${record.nextSteps.length - 1} more)`}
                    </small>
                  ) : (
                    <small>{record.founder ? "Waiting for game update" : "Nothing left to do"}</small>
                  )}
                </td>
                <td>
                  <button
                    className="button secondary small"
                    disabled={busy || resource.loading || resource.refreshing}
                    onClick={() => setSelected(record)}
                  >
                    Review supporter
                  </button>
                </td>
              </tr>
            )}
          />
        ) : (
          <Empty
            title={search || filter ? "No matching supporters" : "No supporter records yet"}
            detail={
              search || filter
                ? "Try another name, account ID or filter."
                : "Records can be entered after checking the member in Patreon, or arrive through connected webhooks. A payment has not been assumed."
            }
          />
        )}
      </Card>
      {selected && (
        <SupporterReview
          record={selected}
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
