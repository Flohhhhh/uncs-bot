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
  const outcome = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (inFlight.current) setBusy(false);
    };
  }, [setBusy]);
  // The form, and the Save button that sent it, are gone once the result shows, so focus moves to the result.
  useEffect(() => {
    if (result) outcome.current?.focus();
  }, [result]);

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
        throw new Error("The save could not be confirmed.");
      }
      setResult({ saved: true, message: "Nothing else changed." });
    } catch (error) {
      if (!mounted.current) return;
      setResult({
        saved: false,
        message: `${error instanceof Error ? error.message : "The save could not be confirmed."} Review ID: ${id}`,
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
      title={result ? (result.saved ? "Saved" : "Not sure it saved") : "Add Patreon member"}
      description={result && !result.saved ? "Close and reload before trying again." : undefined}
      eyebrow={result ? null : "Patreon"}
      busy={sending}
      onClose={onClose}
    >
      {result ? (
        <>
          <p ref={outcome} tabIndex={-1} className={`notice ${result.saved ? "success" : "warning"}`} role="status">
            {result.message}
          </p>
          <div className="dialog-footer">
            <button type="button" className="button secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Patreon membership ID
            <input name="patreonMemberId" required maxLength={100} autoComplete="off" />
          </label>
          <p className="muted">The member ID from Patreon, never a username or user ID.</p>
          <label>
            Display name (optional)
            <input name="displayName" maxLength={120} autoComplete="off" />
          </label>
          <label className="check-label">
            <input name="campaignMembershipVerified" type="checkbox" required />I verified this membership belongs to
            The UNCs Patreon page.
          </label>
          <ReasonField />
          {validation && (
            <p className="notice warning" role="alert">
              {validation}
            </p>
          )}
          <div className="dialog-footer">
            <button type="button" className="button secondary" disabled={sending} onClick={onClose}>
              Cancel
            </button>
            <button className="button primary" disabled={sending || busy || unavailable}>
              {sending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
