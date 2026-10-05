import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api/client";
import { useAdmin } from "../../app/context";
import { Badge, Modal, ReasonField, date } from "../../components/ui";
import { isPublicIndividualSteamId } from "../../../../../src/common/steam-id";
import { errorMessage } from "../actions/policy";
import { stepGroups } from "./policy";
import type { FounderPolicy, PaymentEvidence, Supporter } from "./types";

/**
 * The body of POST supporters/paypal without its request ID. Mirrors paypalSchema in
 * src/supporters/supporters.types.ts. The form never sends a record ID: the server finds the donor's PayPal record
 * by Discord ID or SteamID, or creates one.
 */
export interface PaypalEntry {
  displayName: string;
  discordId?: string;
  steamId?: string;
  paidAt: string;
  amountCents: number;
  currency: string;
  transactionId: string;
  completedPaymentVerified: true;
  firstSuccessfulPaymentVerified: boolean;
  minimumConfirmed: boolean;
  awardFounder: boolean;
  reason: string;
}
export interface PaypalResponse {
  ok: boolean;
  replayed: boolean;
  supporter: Supporter | null;
  payment: PaymentEvidence | null;
  /** The server's founder verdict for this payment. */
  founder: { awarded: boolean; eligible: boolean; blockedReason: string | null } | null;
}

const printable = (value: string) =>
  [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);

/**
 * Reads the form into a request body, or throws what to fix. Every check is the server's own, so a body this returns
 * passes paypalSchema and the server's future-date check. `askFounder` is false only when staff chose to save the
 * payment alone after the server refused a founder.
 */
export function paypalEntry(values: FormData, askFounder: boolean, now = Date.now()): PaypalEntry {
  const text = (name: string) => String(values.get(name) ?? "").trim();
  const displayName = text("displayName");
  if (!displayName || displayName.length > 120 || !printable(displayName))
    throw new Error("Enter a name, up to 120 characters.");
  const discordId = text("discordId");
  if (discordId && !/^\d{17,20}$/.test(discordId)) throw new Error("Enter the Discord user ID, 17 to 20 digits.");
  const amountText = text("amount");
  const amountCents = Math.round(Number(amountText) * 100);
  if (
    !/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(amountText) ||
    !Number.isSafeInteger(amountCents) ||
    amountCents < 1 ||
    amountCents > 100_000_000
  )
    throw new Error("Enter an amount from 0.01 to 1000000.00.");
  // The server takes capitals only. Lower case is accepted here and sent as capitals.
  const currency = text("currency");
  if (!/^[A-Za-z]{3}$/.test(currency)) throw new Error("Enter a 3-letter currency, such as USD.");
  const paidAt = new Date(text("paidAt"));
  if (!Number.isFinite(paidAt.getTime()) || paidAt.getTime() > now + 300_000)
    throw new Error("Enter a payment time that is not in the future.");
  const transactionId = text("transactionId");
  if (!/^[A-Za-z0-9]{10,30}$/.test(transactionId))
    throw new Error("Enter the PayPal transaction ID, 10 to 30 letters and digits.");
  const firstPayment = text("firstPayment");
  if (firstPayment !== "yes" && firstPayment !== "no") throw new Error("Choose whether this is their first payment.");
  const steamId = text("steamId");
  if (steamId && !isPublicIndividualSteamId(steamId)) throw new Error("Enter a valid 17-digit SteamID64.");
  if (values.get("completedPaymentVerified") !== "on")
    throw new Error("Tick that the payment shows Completed in PayPal.");
  const reason = text("reason");
  if (reason.length < 3 || reason.length > 200 || !printable(reason))
    throw new Error("Enter a one-line reason, 3 to 200 characters.");
  return {
    displayName,
    ...(discordId ? { discordId } : {}),
    ...(steamId ? { steamId } : {}),
    paidAt: paidAt.toISOString(),
    amountCents,
    currency: currency.toUpperCase(),
    // The server stores the ID in capitals, and its answer is compared with what was sent.
    transactionId: transactionId.toUpperCase(),
    completedPaymentVerified: true,
    firstSuccessfulPaymentVerified: firstPayment === "yes",
    minimumConfirmed: values.get("minimumConfirmed") === "on",
    // A founder is asked for only when staff say this is the first payment. The server refuses a founder on any other
    // payment and saves nothing, so asking would only cost staff a second save. Whether a first payment makes a
    // founder is the server's decision alone.
    awardFounder: askFounder && firstPayment === "yes",
    reason,
  };
}

/** This minute as a datetime-local value, in the browser's timezone. */
export function localMinute(now = new Date()) {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** A field of the dashboard's ApiError, read without the class so a plain test error works too. */
const errorField = (error: unknown, name: "status" | "blockedReason") =>
  typeof error === "object" && error !== null && name in error ? (error as Record<string, unknown>)[name] : undefined;
const money = (payment: PaymentEvidence) =>
  typeof payment.amountCents === "number"
    ? `${(payment.amountCents / 100).toFixed(2)} ${payment.currency ?? ""}`.trim()
    : "Amount not recorded";

type Saved = { record: Supporter; payment: PaymentEvidence; replayed: boolean; awarded: boolean };

/** The saved record as the server returned it: who, what was paid, founder or not, and the server's next steps. */
function SavedRecord({ saved }: { saved: Saved }) {
  const { record, payment } = saved;
  const { payment: paymentSteps, other, info } = stepGroups(record.nextSteps);
  const needed = [...other, ...paymentSteps];
  const status = useRef<HTMLParagraphElement>(null);
  // The Save button is gone, so focus moves to the result instead of being left on the page behind.
  useEffect(() => status.current?.focus(), []);
  return (
    <>
      <p ref={status} tabIndex={-1} className={`notice ${saved.replayed ? "info" : "success"}`} role="status">
        {saved.replayed ? "This payment was already on record." : saved.awarded ? "Saved as a founder." : "Saved."}
      </p>
      <div className="application-identity">
        <div>
          <strong>{record.displayName || "PayPal supporter"}</strong>
          <small>
            {money(payment)} · {date(payment.paidAt)}
          </small>
          <small>Transaction {payment.reference}</small>
          <small>{record.discordId ? `Discord ${record.discordId}` : "No Discord account"}</small>
          {record.steamId && <small>SteamID {record.steamId}</small>}
        </div>
        <Badge kind={record.founder ? "good" : "neutral"}>{record.founder ? "Founder" : "Not a founder"}</Badge>
      </div>
      {(needed.length > 0 || info.length > 0) && (
        <div className="supporter-steps">
          {info.map((step) => (
            <p className="muted" key={step.code}>
              {step.message}
            </p>
          ))}
          {needed.length > 0 && (
            <>
              <h3>Still needed</h3>
              <ul>
                {needed.map((step) => (
                  <li key={step.code}>{step.message}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </>
  );
}

function PaypalForm({
  policy,
  onClose,
  onRecorded,
  onOpen,
}: {
  policy: FounderPolicy;
  onClose: () => void;
  onRecorded: () => void;
  onOpen: (record: Supporter) => void;
}) {
  const { busy, setBusy } = useAdmin();
  // Each entry starts from a fresh form: USD, paid this minute.
  const [entry, setEntry] = useState(() => ({ round: 0, paidAt: localMinute() }));
  const [currency, setCurrency] = useState<string>(policy.currency);
  // The save in flight: "entry" from Save supporter, "alone" from Save without founder.
  const [sending, setSending] = useState<"entry" | "alone" | null>(null);
  const [problem, setProblem] = useState("");
  // The server refused to make this entry a founder and saved nothing, so staff may save the payment alone. The
  // refusal was for the entry as sent, so it stands until the entry is edited.
  const [founderRefused, setFounderRefused] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const aloneButton = useRef<HTMLButtonElement>(null);
  // The button for the next step after a save that did not finish.
  const nextStep = useRef<"entry" | "alone" | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  // One request ID per distinct entry, so saving the same entry again is a repeat the server recognises.
  const ids = useRef(new Map<string, string>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (inFlight.current) setBusy(false);
    };
  }, [setBusy]);
  // Staff start typing straight away, on opening and on each further entry.
  useEffect(() => name.current?.focus(), [entry.round]);
  // Saving disables every control, which drops focus. A save that did not finish puts focus on its next step once
  // the buttons can be pressed again, so one more Enter carries on.
  useEffect(() => {
    if (sending || !nextStep.current) return;
    (nextStep.current === "alone" ? aloneButton : saveButton).current?.focus();
    nextStep.current = null;
  }, [sending]);

  /**
   * Saves the entry. A first payment asks for a founder, and the server decides. When it refuses, it saves nothing
   * and says why; staff can then save the payment alone (`askFounder` false). The save never waits for the page's
   * list: the request names no record, and saving again after an unconfirmed save must stay possible while the list
   * cannot be read.
   */
  async function save(askFounder: boolean) {
    if (busy || inFlight.current || !form.current) return;
    let input: PaypalEntry;
    try {
      // Read before the fields are disabled for sending: a disabled field is left out of the form data.
      input = paypalEntry(new FormData(form.current), askFounder);
    } catch (error) {
      setProblem(errorMessage(error));
      return;
    }
    const pressed = askFounder ? "entry" : "alone";
    inFlight.current = true;
    setSending(pressed);
    setBusy(true);
    setProblem("");
    let refresh = true;
    try {
      const key = JSON.stringify(input);
      const id = ids.current.get(key) ?? crypto.randomUUID();
      ids.current.set(key, id);
      const response = await api<PaypalResponse>("supporters/paypal", {
        method: "POST",
        body: JSON.stringify({ id, ...input }),
      });
      if (!mounted.current) return;
      if (
        !response.ok ||
        !response.supporter?.id ||
        response.payment?.reference !== input.transactionId ||
        !response.founder
      )
        throw new Error("The save could not be confirmed.");
      setFounderRefused(false);
      setSaved({
        record: response.supporter,
        payment: response.payment,
        replayed: Boolean(response.replayed),
        awarded: response.founder.awarded === true,
      });
    } catch (error) {
      if (!mounted.current) return;
      const status = errorField(error, "status");
      nextStep.current = pressed;
      // A 4xx is the server's refusal: nothing was saved, and its own words say what to fix. A 404 is not one, because
      // the server sends it when a saved record could not be read back.
      if (typeof status === "number" && status >= 400 && status < 500 && status !== 404) {
        refresh = false;
        setProblem(errorMessage(error));
        if (input.awardFounder && status === 409 && typeof errorField(error, "blockedReason") === "string") {
          setFounderRefused(true);
          nextStep.current = "alone";
        }
      } else
        // Saving again repeats this request under the same ID, so the server answers with what it saved.
        setProblem(
          `${typeof status === "number" && status >= 500 ? errorMessage(error) : "The save could not be confirmed."} Save again to check. The same payment never saves twice.`,
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setSending(null);
        setBusy(false);
        if (refresh) onRecorded();
      }
    }
  }

  const otherCurrency = /^[A-Za-z]{3}$/.test(currency.trim()) && currency.trim().toUpperCase() !== policy.currency;
  return (
    <Modal
      className="supporter-dialog"
      title={saved ? (saved.replayed ? "Already saved" : "Supporter saved") : "Add PayPal supporter"}
      description={
        saved
          ? !saved.replayed && saved.record.discordId
            ? "With Discord roles on, Gramps checks their roles next."
            : undefined
          : "Check the payment in PayPal first."
      }
      eyebrow={saved ? null : undefined}
      busy={sending !== null}
      onClose={onClose}
    >
      {saved ? (
        <>
          <SavedRecord saved={saved} />
          <div className="dialog-footer">
            <button type="button" className="button secondary" onClick={() => onOpen(saved.record)}>
              Open record
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setSaved(null);
                setProblem("");
                setCurrency(policy.currency);
                setEntry((previous) => ({ round: previous.round + 1, paidAt: localMinute() }));
              }}
            >
              Add another
            </button>
            <button type="button" className="button secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <form
          ref={form}
          key={entry.round}
          // The refusal was for the entry as sent, so an edited entry asks the server again.
          onChange={() => setFounderRefused(false)}
          onSubmit={(event) => {
            event.preventDefault();
            void save(true);
          }}
        >
          <fieldset disabled={sending !== null} className="review-fields">
            <div className="supporter-form-grid">
              <label>
                Name
                <input ref={name} name="displayName" required autoComplete="off" placeholder="Discord or game name" />
              </label>
              <label>
                Discord user ID
                <input name="discordId" inputMode="numeric" autoComplete="off" />
                <small>Needed for Discord roles.</small>
              </label>
            </div>
            <div className="supporter-form-grid">
              <label>
                Amount
                <input type="number" name="amount" required min="0.01" step="0.01" max="1000000" placeholder="5.00" />
              </label>
              <label>
                Currency
                <input
                  name="currency"
                  required
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value)}
                />
              </label>
            </div>
            <div className="supporter-form-grid">
              <label>
                Paid on
                <input type="datetime-local" name="paidAt" required step={60} defaultValue={entry.paidAt} />
                <small>Your local time.</small>
              </label>
              <label>
                PayPal transaction ID
                <input
                  name="transactionId"
                  required
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                />
              </label>
            </div>
            <div className="supporter-form-grid">
              <label>
                First payment?
                <select name="firstPayment" required defaultValue="">
                  <option value="" disabled>
                    Choose
                  </option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
                <small>No saves it without a founder.</small>
              </label>
              <label>
                SteamID64 (optional)
                <input name="steamId" inputMode="numeric" autoComplete="off" />
              </label>
            </div>
            <label className="supporter-check">
              <input type="checkbox" name="completedPaymentVerified" required />
              <span>Shows Completed in PayPal</span>
            </label>
            {otherCurrency && (
              <label className="supporter-check">
                <input type="checkbox" name="minimumConfirmed" />
                <span>Worth US${policy.amountCents / 100} or more</span>
              </label>
            )}
            <ReasonField defaultValue="Checked the payment in PayPal." />
          </fieldset>
          {problem && (
            <p className="notice warning" role="alert">
              {problem}
            </p>
          )}
          <div className="dialog-footer">
            <button type="button" className="button secondary" disabled={sending !== null} onClick={onClose}>
              Cancel
            </button>
            {/* While the refusal stands this is the next step, so it is the primary button and takes focus. That happens
                right after a press meant for Save supporter, so a held Enter key or the second click of a double click
                does not press it. */}
            {founderRefused && (
              <button
                ref={aloneButton}
                type="button"
                className="button primary"
                disabled={sending !== null || busy}
                onKeyDown={(event) => {
                  if (event.repeat && event.key === "Enter") event.preventDefault();
                }}
                onClick={(event) => {
                  if (event.detail < 2 && form.current?.reportValidity()) void save(false);
                }}
              >
                {sending === "alone" ? "Saving…" : "Save without founder"}
              </button>
            )}
            <button
              ref={saveButton}
              type="submit"
              className={`button ${founderRefused ? "secondary" : "primary"}`}
              disabled={sending !== null || busy}
            >
              {sending === "entry" ? "Saving…" : "Save supporter"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/**
 * The Supporters page's "Add PayPal supporter" button and its dialog. PayPal records need no Patreon connection, so
 * the button only waits for the page's records to be current, like every other supporter write action. Once the
 * dialog is open its saves do not wait for the list, so an entry can be saved again while the list cannot be read.
 */
export function AddPaypalSupporter({
  unavailable,
  policy,
  onRecorded,
  onOpen,
}: {
  /** The page's records are loading, refreshing or failed to load. */
  unavailable: boolean;
  policy: FounderPolicy;
  /** Called after a save, or a save that could not be confirmed, so the page reads its records again. */
  onRecorded: () => void;
  /** Opens the saved record's review dialog. */
  onOpen: (record: Supporter) => void;
}) {
  const { me, busy } = useAdmin();
  const [open, setOpen] = useState(false);
  // Only administrators can record supporters; the server checks the role again.
  if (me.role !== "admin") return null;
  return (
    <>
      <button type="button" className="button secondary" disabled={busy || unavailable} onClick={() => setOpen(true)}>
        Add PayPal supporter
      </button>
      {/* The dialog sits outside the toolbar, so the toolbar's button and layout rules never reach into it. */}
      {open &&
        createPortal(
          <PaypalForm
            policy={policy}
            onClose={() => setOpen(false)}
            onRecorded={onRecorded}
            onOpen={(record) => {
              setOpen(false);
              onOpen(record);
            }}
          />,
          document.body,
        )}
    </>
  );
}
