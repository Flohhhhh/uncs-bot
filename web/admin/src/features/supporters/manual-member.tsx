import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useAdmin } from "../../app/context";
import { Modal, ReasonField } from "../../components/ui";
import type { SupporterReviewResponse } from "./types";

export function ManualMember({
  unavailable,
  onClose,
  onRecorded,
}: {
  unavailable: boolean;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const { busy, setBusy } = useAdmin();
  const [id] = useState(() => crypto.randomUUID());
  const [sending, setSending] = useState(false);
  const [validation, setValidation] = useState("");
  const [result, setResult] = useState<{ saved: boolean; message: string } | null>(null);
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || unavailable || submitted.current) return;
    const data = new FormData(event.currentTarget);
    const patreonMemberId = String(data.get("patreonMemberId") ?? "").trim();
    const displayName = String(data.get("displayName") ?? "").trim();
    const reason = String(data.get("reason") ?? "").trim();
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(patreonMemberId) ||
      data.get("campaignMembershipVerified") !== "on" ||
      displayName.length > 120 ||
      reason.length < 3 ||
      reason.length > 200 ||
      [...(displayName + reason)].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ) {
      setValidation("Check the membership ID, campaign confirmation and single-line reason.");
      return;
    }
    submitted.current = true;
    inFlight.current = true;
    setSending(true);
    setBusy(true);
    setValidation("");
    try {
      const response = await api<SupporterReviewResponse>("supporters/manual-member", {
        method: "POST",
        body: JSON.stringify({
          id,
          patreonMemberId,
          displayName: displayName || null,
          campaignMembershipVerified: true,
          reason,
        }),
      });
      if (!mounted.current) return;
      if (
        !response.ok ||
        !response.supporter?.id ||
        response.supporter.patreonMemberId !== patreonMemberId ||
        !Number.isInteger(response.supporter.version) ||
        response.supporter.version < 1
      ) {
        throw new Error("The saved membership record could not be confirmed. Refresh before another entry.");
      }
      setResult({
        saved: true,
        message: `Membership recorded for separate identity and payment review. Review ID: ${id}`,
      });
    } catch (error) {
      if (!mounted.current) return;
      setResult({
        saved: false,
        message: `${error instanceof Error ? error.message : "The saved record could not be confirmed."} Review ID: ${id}`,
      });
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setSending(false);
        setBusy(false);
        onRecorded();
      }
    }
  }

  return (
    <Modal
      title={
        result
          ? result.saved
            ? "Membership record saved"
            : "Save result not confirmed"
          : "Record existing Patreon member"
      }
      description={
        result
          ? "No payment, founder promise, game access or Discord role was granted."
          : "Use this when an existing Patreon member is missing from this page. Check their membership on The UNCs creator page before entering it."
      }
      busy={sending}
      onClose={onClose}
    >
      {result ? (
        <>
          <p className={`notice ${result.saved ? "success" : "warning"}`} role="status">
            {result.message}
          </p>
          {!result.saved && (
            <p>
              Close and refresh the records before trying another entry. A response failure does not prove nothing was
              saved.
            </p>
          )}
          <button className="button secondary" onClick={onClose}>
            Close record
          </button>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Patreon membership ID
            <input name="patreonMemberId" required maxLength={100} autoComplete="off" />
          </label>
          <p className="muted">
            Use the membership ID from verified Patreon v2 member data or a signed webhook. A Patreon username, user ID,
            campaign ID or tier ID is a different identifier. Never invent a membership ID.
          </p>
          <label>
            Display name (optional)
            <input name="displayName" maxLength={120} autoComplete="off" />
          </label>
          <label className="check-label">
            <input name="campaignMembershipVerified" type="checkbox" required />I verified this membership belongs to
            The UNCs Patreon page.
          </label>
          <ReasonField />
          <p className="muted">
            This creates an unverified record only. Check a completed receipt separately before recording any founder
            promise.
          </p>
          {validation && (
            <p className="notice warning" role="alert">
              {validation}
            </p>
          )}
          <button className="button primary" disabled={sending || busy || unavailable}>
            {sending ? "Saving record…" : "Save membership record"}
          </button>
        </form>
      )}
    </Modal>
  );
}
