import { useEffect, useRef, useState } from "react";
import type { Audit } from "../../api/types";
import { useGameApi } from "../../api/server-client";
import { useAdmin } from "../../app/context";
import { CopyValue } from "../../components/data-table";
import { OutcomeBadge, outcomeLabels } from "../../components/ui";
import { errorMessage } from "./policy";

type Receipt = Pick<Audit, "id" | "state" | "message">;

export function ActionReceipt({ id }: { id: string }) {
  const { server } = useAdmin();
  return <ReceiptRead key={`${server?.id}:${server?.version}:${id}`} id={id} />;
}

function ReceiptRead({ id }: { id: string }) {
  const api = useGameApi();
  const { busy } = useAdmin();
  const pending = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ record: Receipt | null } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => () => pending.current?.abort(), []);

  async function read() {
    if (busy || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setResult(null);
    setError("");
    try {
      const response = await api<{ record: Receipt | null }>(`audit/${id}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (
        !response ||
        typeof response !== "object" ||
        !("record" in response) ||
        (response.record !== null &&
          (!response.record ||
            typeof response.record !== "object" ||
            response.record.id !== id ||
            !Object.hasOwn(outcomeLabels, response.record.state) ||
            typeof response.record.message !== "string"))
      )
        throw new Error("The saved result did not match this action. Check Action history.");
      setResult(response);
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setLoading(false);
      }
    }
  }

  return (
    <details className="action-receipt">
      <summary>Action details</summary>
      <div className="action-receipt-tools">
        <button type="button" className="button secondary small" disabled={loading || busy} onClick={() => void read()}>
          {loading ? "Checking saved result…" : "Check saved result"}
        </button>
        <CopyValue value={id} label="action ID" />
      </div>
      {error && <p role="alert">{error} You can retry this read without resending the action.</p>}
      {result && (
        <div role="status" aria-label="Saved action result">
          {result.record ? (
            <>
              <p className="action-receipt-outcome">
                <strong>Recorded outcome:</strong> <OutcomeBadge state={result.record.state} />
              </p>
              <p>{result.record.message}</p>
              <p className="muted">This reads the stored receipt. It does not resend the action or recheck the game.</p>
            </>
          ) : (
            <>
              <strong>No stored receipt found</strong>
              <p>This does not establish whether the game acted. Check the game before repeating the action.</p>
            </>
          )}
        </div>
      )}
    </details>
  );
}
