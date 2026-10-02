import { useEffect, useRef, useState, type FormEvent } from "react";
import { useGameApi } from "../../api/server-client";
import { useResource } from "../../api/use-resource";
import { useGameAdmin as useAdmin } from "../../app/context";
import { Badge, Card, Empty, Modal, ReasonField, Search, date } from "../../components/ui";
import { CopyValue, DataTable } from "../../components/data-table";
import type {
  ApplicationDecision,
  ApplicationReviewResponse,
  ApplicationsResponse,
  WhitelistApplication,
} from "./types";

const statuses = {
  pending: "Awaiting review",
  processing: "Awaiting confirmation",
  approved: "Approved",
  declined: "Declined",
  needs_review: "Needs review",
};
const relationships = {
  unc_member: "UNC member (self-reported)",
  friend_regular: "Friend or server regular (self-reported)",
  new_player: "New player (self-reported)",
};
const decisions = {
  approve: {
    title: "Approve whitelist access",
    description:
      "Review the Discord account and requested SteamID below. Approval adds this SteamID to the existing whitelist; it does not change anyone else’s access.",
    confirmation: "Grant whitelist access to",
    reason: "Website whitelist application reviewed and approved.",
    submit: "Approve this SteamID",
  },
  decline: {
    title: "Decline application",
    description:
      "Record why this application is declined. This does not remove any existing whitelist access or ban the player.",
    confirmation: "Decline the application from",
    reason: "",
    submit: "Confirm decline",
  },
  recheck: {
    title: "Recheck live whitelist",
    description:
      "Read the running whitelist to check whether this SteamID already has access. This does not add, remove, or resend anything to the game.",
    confirmation: "Check existing access for",
    reason: "Recheck the existing application against the running whitelist.",
    submit: "Check running whitelist",
  },
};

function ApplicationBadge({ record }: { record: WhitelistApplication }) {
  return (
    <Badge
      kind={
        record.status === "approved"
          ? "good"
          : ["needs_review", "processing"].includes(record.status)
            ? "warn"
            : "neutral"
      }
    >
      {statuses[record.status] ?? "Needs review"}
    </Badge>
  );
}

function ApplicationDetails({ record }: { record: WhitelistApplication }) {
  return (
    <>
      <div className="application-identity">
        <div>
          <span className="eyebrow">AUTHENTICATED DISCORD ACCOUNT</span>
          <strong>{record.discordDisplayName}</strong>
          <small>{record.discordUserId}</small>
        </div>
        <ApplicationBadge record={record} />
      </div>
      <dl className="application-details">
        <div>
          <dt>SteamID64</dt>
          <dd>
            <strong>{record.steamId}</strong>
            <small>Self-reported · ownership not verified</small>
          </dd>
        </div>
        <div>
          <dt>Community connection</dt>
          <dd>
            {relationships[record.relationship] ?? "Not recorded"}
            <small>This answer does not assign a Discord role or priority tier.</small>
          </dd>
        </div>
        <div>
          <dt>Email · private</dt>
          <dd className="application-email">
            {record.email || "Not provided"}
            <small>{record.emailVerified ? "Verified by the application service" : "Unverified email address"}</small>
          </dd>
        </div>
        <div>
          <dt>Application contact consent</dt>
          <dd>{record.contactConsent ? `Given · ${date(record.contactConsentAt)}` : "Not given"}</dd>
        </div>
        <div>
          <dt>Rules accepted</dt>
          <dd>{date(record.rulesAcceptedAt)}</dd>
        </div>
        <div>
          <dt>Submitted</dt>
          <dd>{date(record.submittedAt)}</dd>
        </div>
        {record.reviewedAt && (
          <div>
            <dt>Last staff review</dt>
            <dd>
              {date(record.reviewedAt)}
              <small>{record.reviewReason}</small>
            </dd>
          </div>
        )}
      </dl>
      {record.lastActionState && (
        <div className={`notice ${record.status === "approved" ? "" : "warning"}`}>
          <strong>Last review: {record.lastActionState}</strong>
          <br />
          {record.lastActionMessage || "No additional details were recorded."}
          {(record.reviewId || record.actionId) && (
            <small className="application-action-id">Review ID: {record.reviewId || record.actionId}</small>
          )}
          {record.actionId && record.reviewKind !== "decline" && record.status !== "declined" && (
            <small className="application-action-id">Original whitelist action ID: {record.actionId}</small>
          )}
        </div>
      )}
    </>
  );
}

type ReviewResult = { title: string; description: string; message: string; complete: boolean };

function canReview(record: WhitelistApplication, decision: ApplicationDecision) {
  return decision === "recheck" ? ["processing", "needs_review"].includes(record.status) : record.status === "pending";
}

function ApplicationReview({
  record: initialRecord,
  unavailable,
  onClose,
  onReviewed,
}: {
  record: WhitelistApplication;
  unavailable: boolean;
  onClose: () => void;
  onReviewed: () => void;
}) {
  const { busy, setBusy } = useAdmin();
  const api = useGameApi();
  const [record, setRecord] = useState(initialRecord);
  const [review, setReview] = useState<{ decision: ApplicationDecision; id: string } | null>(null);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [sending, setSending] = useState(false);
  const [validation, setValidation] = useState("");
  const submitted = useRef(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (inFlight.current) setBusy(false);
    };
  }, [setBusy]);

  function choose(decision: ApplicationDecision) {
    if (busy || unavailable || submitted.current || !canReview(record, decision)) return;
    setReview({ decision, id: crypto.randomUUID() });
    setValidation("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!review || busy || unavailable || submitted.current || !canReview(record, review.decision)) return;
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    if (
      reason.length < 3 ||
      reason.length > 200 ||
      [...reason].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ) {
      setValidation("Enter a single-line review reason between 3 and 200 characters.");
      return;
    }
    submitted.current = true;
    inFlight.current = true;
    setSending(true);
    setBusy(true);
    setValidation("");
    try {
      const response = await api<ApplicationReviewResponse>(
        `applications/${encodeURIComponent(record.id)}/${review.decision}`,
        {
          method: "POST",
          body: JSON.stringify({ id: review.id, reason }),
        },
      );
      if (!mounted.current) return;
      if (response.application?.id !== record.id || response.outcome?.id !== review.id) {
        throw new Error("The review receipt did not match this request.");
      }
      const approved =
        ["approve", "recheck"].includes(review.decision) &&
        response.application.status === "approved" &&
        response.outcome.state === "applied";
      const declined =
        review.decision === "decline" &&
        response.application.status === "declined" &&
        response.outcome.state === "applied";
      const complete = approved || declined;
      setRecord(response.application);
      setResult({
        title: approved ? "Whitelist access confirmed" : declined ? "Application declined" : "Application needs review",
        description: complete
          ? response.outcome.message
          : `Approval or review is not confirmed. ${response.outcome.message || "Check Action history before repeating the request."}`,
        message: `${response.outcome.message || "The decision requires follow-up."} Review ID: ${review.id}`,
        complete,
      });
    } catch (error) {
      if (!mounted.current) return;
      setResult({
        title: "Review result not confirmed",
        description: "Refresh this application and check Action history before repeating the request.",
        message: `${error instanceof Error ? error.message : "The review result could not be confirmed."} Review ID: ${review.id}`,
        complete: false,
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
  return (
    <Modal
      serverScoped
      className="application-dialog"
      title={result?.title ?? selected?.title ?? "Whitelist application"}
      description={
        result?.description ?? selected?.description ?? "Review the request and the applicant’s contact details."
      }
      busy={sending}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <ApplicationDetails record={record} />
        {!review && record.status === "pending" && (
          <div className="action-list">
            <button
              type="button"
              className="button primary"
              disabled={busy || unavailable}
              onClick={() => choose("approve")}
            >
              Review approval
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy || unavailable}
              onClick={() => choose("decline")}
            >
              Decline request
            </button>
          </div>
        )}
        {!review && canReview(record, "recheck") && (
          <>
            <p className="muted">
              Approval has not been confirmed. Recheck the running whitelist without sending another grant.
            </p>
            <button
              type="button"
              className="button secondary"
              disabled={busy || unavailable}
              onClick={() => choose("recheck")}
            >
              Recheck live whitelist
            </button>
          </>
        )}
        {review && selected && !result && (
          <>
            <fieldset disabled={sending} className="review-fields">
              <ReasonField key={review.id} defaultValue={selected.reason} />
            </fieldset>
            <div className="application-confirm">
              <strong>
                {selected.confirmation} {record.discordDisplayName}
              </strong>
              <span>SteamID64 {record.steamId}</span>
            </div>
          </>
        )}
        {validation && (
          <p className="notice warning" role="alert">
            {validation}
          </p>
        )}
        {result && (
          <p className={`notice ${result.complete ? "" : "warning"}`} role="status">
            {result.message}
          </p>
        )}
        <div className="dialog-footer">
          <button type="button" className="button secondary" disabled={sending} onClick={onClose}>
            {review && !result ? "Cancel" : "Close"}
          </button>
          {review && selected && !result && (
            <button type="submit" className="button primary" disabled={busy || unavailable || submitted.current}>
              {sending ? "Recording decision…" : selected.submit}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function AdminApplications() {
  const { busy } = useAdmin();
  const resource = useResource<ApplicationsResponse>("applications");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<WhitelistApplication | null>(null);
  const records = resource.data?.applications;
  if (!records)
    return (
      <Empty
        title={resource.error ? "Applications could not be loaded" : "Loading applications…"}
        detail={resource.error ? "Use Refresh to try again." : undefined}
      />
    );
  const needle = query.trim().toLocaleLowerCase();
  const rows = records.filter(
    (record) =>
      (!status || record.status === status) &&
      [record.discordDisplayName, record.discordUserId, record.steamId].some((value) =>
        value.toLocaleLowerCase().includes(needle),
      ),
  );
  return (
    <>
      {resource.error && (
        <p className="notice warning" role="alert">
          Applications could not be refreshed. Refresh before reviewing a request.
        </p>
      )}
      <div className="application-counts">
        <span>
          <strong>{records.filter((record) => record.status === "pending").length}</strong> awaiting review in this list
        </span>
        <span>
          <strong>{records.filter((record) => ["processing", "needs_review"].includes(record.status)).length}</strong>{" "}
          need follow-up
        </span>
        <span>Up to 100 requests; awaiting review first</span>
      </div>
      <Search value={query} onChange={setQuery} placeholder="Search Discord name, Discord ID, or SteamID">
        <select aria-label="Application status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">All statuses</option>
          {Object.entries(statuses).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {status && (
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setStatus("");
              setQuery("");
            }}
          >
            Reset filters
          </button>
        )}
      </Search>
      <Card
        title="Community requests"
        subtitle={`${rows.length} shown of ${records.length} loaded · private email inside each request`}
        badge={<Badge>ADMIN ONLY</Badge>}
      >
        {rows.length ? (
          <DataTable
            label="Community requests"
            rows={rows}
            columns={[
              { label: "Discord / SteamID", value: (record) => record.discordDisplayName },
              { label: "Community connection", value: (record) => relationships[record.relationship] },
              { label: "Submitted", value: (record) => Date.parse(record.submittedAt), firstDirection: "descending" },
              { label: "Status", value: (record) => statuses[record.status] },
              { label: "Actions" },
            ]}
            renderRow={(record) => (
              <tr key={record.id}>
                <td>
                  <strong>{record.discordDisplayName}</strong>
                  <small>
                    <CopyValue value={record.steamId} />
                  </small>
                </td>
                <td className="application-relationship">{relationships[record.relationship] ?? "Not recorded"}</td>
                <td>{new Date(record.submittedAt).toLocaleDateString()}</td>
                <td>
                  <ApplicationBadge record={record} />
                </td>
                <td>
                  <button
                    className="button secondary small"
                    disabled={busy || resource.loading}
                    onClick={() => setSelected(record)}
                  >
                    View request
                  </button>
                </td>
              </tr>
            )}
          />
        ) : (
          <Empty
            title={query.trim() || status ? "No matching applications" : "No applications yet"}
            detail={records.length ? "Try another Discord name or SteamID." : "New website requests will appear here."}
          />
        )}
      </Card>
      {selected && (
        <ApplicationReview
          record={selected}
          unavailable={Boolean(resource.error) || resource.loading}
          onClose={() => setSelected(null)}
          onReviewed={() => {
            void resource.refresh();
          }}
        />
      )}
    </>
  );
}

export function ApplicationsPage() {
  const { me } = useAdmin();
  return me.role === "admin" ? (
    <AdminApplications key={`${me.id}:${me.csrf}`} />
  ) : (
    <Empty title="Administrator access required" />
  );
}
