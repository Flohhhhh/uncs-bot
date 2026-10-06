"use client";

import { useRef, useState, type FormEvent } from "react";
import { PlusIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

import { PaypalSupporterError, recordPaypalSupporter, type PaypalSupporterInput } from "./supporters-data";

function localMinute(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function isPublicSteamId(value: string) {
  if (!/^\d{17}$/.test(value)) return false;
  const id = BigInt(value);
  return id >= 76561197960265729n && id <= 76561202255233023n;
}

function parsePaypalEntry(values: FormData, id: string, awardFounder: boolean, now = Date.now()): PaypalSupporterInput {
  const text = (name: string) => String(values.get(name) ?? "").trim();
  const displayName = text("displayName");
  if (!displayName || displayName.length > 120 || [...displayName].some((char) => char.charCodeAt(0) < 32)) {
    throw new Error("Enter a name of up to 120 characters.");
  }

  const discordId = text("discordId");
  if (discordId && !/^\d{17,20}$/.test(discordId)) throw new Error("Enter a Discord user ID between 17 and 20 digits.");

  const steamId = text("steamId");
  if (steamId && !isPublicSteamId(steamId)) throw new Error("Enter a valid 17-digit SteamID64.");

  const amountText = text("amount");
  const amountCents = Math.round(Number(amountText) * 100);
  if (
    !/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(amountText) ||
    !Number.isSafeInteger(amountCents) ||
    amountCents < 1 ||
    amountCents > 100_000_000
  ) {
    throw new Error("Enter an amount from 0.01 to 1000000.00 with at most two decimal places.");
  }

  const currency = text("currency");
  if (!/^[A-Za-z]{3}$/.test(currency)) throw new Error("Enter a 3-letter currency code, such as USD.");

  const paidAt = new Date(text("paidAt"));
  if (!Number.isFinite(paidAt.getTime()) || paidAt.getTime() > now + 300_000) {
    throw new Error("Enter a payment date that is not in the future.");
  }

  const transactionId = text("transactionId");
  if (!/^[A-Za-z0-9]{10,30}$/.test(transactionId)) {
    throw new Error("Enter a PayPal transaction ID of 10 to 30 letters and digits.");
  }

  const firstPayment = text("firstPayment");
  if (firstPayment !== "yes" && firstPayment !== "no") throw new Error("Choose whether this is their first payment.");
  if (values.get("completedPaymentVerified") !== "on")
    throw new Error("Confirm that the payment shows Completed in PayPal.");

  const reason = text("reason");
  if (reason.length < 3 || reason.length > 200 || [...reason].some((char) => char.charCodeAt(0) < 32)) {
    throw new Error("Enter a one-line reason between 3 and 200 characters.");
  }

  return {
    id,
    displayName,
    ...(discordId ? { discordId } : {}),
    ...(steamId ? { steamId } : {}),
    paidAt: paidAt.toISOString(),
    amountCents,
    currency: currency.toUpperCase(),
    transactionId: transactionId.toUpperCase(),
    completedPaymentVerified: true,
    firstSuccessfulPaymentVerified: firstPayment === "yes",
    minimumConfirmed: values.get("minimumConfirmed") === "on",
    awardFounder: awardFounder && firstPayment === "yes",
    reason,
  };
}

export function AddPaypalSupporterDialog({
  csrf,
  available,
  founderMinimumCents,
  onRecorded,
}: {
  csrf: string;
  available: boolean;
  founderMinimumCents: number;
  onRecorded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [founderBlocked, setFounderBlocked] = useState(false);
  const [saved, setSaved] = useState<{ replayed: boolean; founderAwarded: boolean } | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [firstPayment, setFirstPayment] = useState("");
  const [paidAt, setPaidAt] = useState(() => localMinute());
  const actionId = useRef<string | null>(null);
  const inFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  function resetForAnother() {
    setProblem(null);
    setFounderBlocked(false);
    setSaved(null);
    setCurrency("USD");
    setFirstPayment("");
    setPaidAt(localMinute());
    actionId.current = null;
    formRef.current?.reset();
  }

  async function save(awardFounder: boolean) {
    if (!formRef.current || inFlight.current) return;
    let input: PaypalSupporterInput;
    try {
      input = parsePaypalEntry(new FormData(formRef.current), actionId.current ?? crypto.randomUUID(), awardFounder);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Check the payment details.");
      return;
    }

    actionId.current = input.id;
    inFlight.current = true;
    setProblem(null);
    setSaving(true);
    try {
      const result = await recordPaypalSupporter(csrf, input);
      setSaved(result);
      setFounderBlocked(false);
      onRecorded();
    } catch (error) {
      if (error instanceof PaypalSupporterError && error.status === 409 && error.blockedReason && input.awardFounder) {
        setFounderBlocked(true);
      }
      setProblem(error instanceof Error ? error.message : "The PayPal payment could not be recorded.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save(true);
  }

  const otherCurrency = /^[A-Za-z]{3}$/.test(currency.trim()) && currency.trim().toUpperCase() !== "USD";

  return (
    <>
      <Button
        disabled={!available}
        onClick={() => {
          setPaidAt(localMinute());
          setOpen(true);
        }}
      >
        <PlusIcon data-icon="inline-start" />
        Add PayPal supporter
      </Button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!saving) setOpen(nextOpen);
          if (!nextOpen && !saving) resetForAnother();
        }}
      >
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {saved ? (saved.replayed ? "Payment already recorded" : "Supporter saved") : "Add PayPal supporter"}
            </DialogTitle>
            <DialogDescription>
              {saved
                ? saved.founderAwarded
                  ? "The payment was recorded and the supporter was made a founder."
                  : "The completed payment was recorded."
                : "Check the completed payment in PayPal before recording it."}
            </DialogDescription>
          </DialogHeader>

          {saved ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={resetForAnother}>
                Add another
              </Button>
              <Button
                onClick={() => {
                  setOpen(false);
                  resetForAnother();
                }}
              >
                Close
              </Button>
            </div>
          ) : (
            <form
              ref={formRef}
              className="space-y-4"
              onSubmit={submit}
              onChange={(event) => {
                const target = event.target;
                if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
                  actionId.current = null;
                  setFounderBlocked(false);
                  setProblem(null);
                  if (target.name === "currency") setCurrency(target.value);
                  if (target.name === "firstPayment") setFirstPayment(target.value);
                  if (target.name === "paidAt") setPaidAt(target.value);
                }
              }}
            >
              <fieldset disabled={saving} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="supporter-name">Name</Label>
                    <Input
                      id="supporter-name"
                      name="displayName"
                      required
                      maxLength={120}
                      placeholder="Supporter name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="supporter-discord">Discord user ID</Label>
                    <Input id="supporter-discord" name="discordId" inputMode="numeric" placeholder="Optional" />
                    <p className="text-xs text-muted-foreground">Needed if they should receive Discord roles.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="supporter-amount">Amount</Label>
                    <Input
                      id="supporter-amount"
                      name="amount"
                      type="number"
                      min="0.01"
                      max="1000000"
                      step="0.01"
                      required
                      placeholder="5.00"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="supporter-currency">Currency</Label>
                    <Input
                      id="supporter-currency"
                      name="currency"
                      required
                      maxLength={3}
                      value={currency}
                      onChange={(event) => setCurrency(event.currentTarget.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="supporter-paid-at">Paid on</Label>
                    <Input
                      id="supporter-paid-at"
                      name="paidAt"
                      type="datetime-local"
                      required
                      step={60}
                      value={paidAt}
                      onChange={(event) => setPaidAt(event.currentTarget.value)}
                    />
                    <p className="text-xs text-muted-foreground">Your local time.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="supporter-transaction">PayPal transaction ID</Label>
                    <Input id="supporter-transaction" name="transactionId" required maxLength={30} autoComplete="off" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="supporter-first-payment">First successful payment?</Label>
                    <select
                      id="supporter-first-payment"
                      name="firstPayment"
                      required
                      value={firstPayment}
                      onChange={(event) => setFirstPayment(event.currentTarget.value)}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <option value="" disabled>
                        Choose
                      </option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                    <p className="text-xs text-muted-foreground">The server checks founder eligibility.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="supporter-steam">SteamID64</Label>
                    <Input
                      id="supporter-steam"
                      name="steamId"
                      inputMode="numeric"
                      maxLength={17}
                      placeholder="Optional"
                    />
                  </div>
                </div>

                <label className="flex items-start gap-2 text-sm">
                  <input
                    name="completedPaymentVerified"
                    type="checkbox"
                    required
                    className="mt-0.5 size-4 accent-primary"
                  />
                  <span>I checked that the transaction shows Completed in PayPal.</span>
                </label>
                {otherCurrency ? (
                  <label className="flex items-start gap-2 text-sm">
                    <input name="minimumConfirmed" type="checkbox" className="mt-0.5 size-4 accent-primary" />
                    <span>Confirm this payment is worth at least US${(founderMinimumCents / 100).toFixed(2)}.</span>
                  </label>
                ) : null}
                <div className="space-y-2">
                  <Label htmlFor="supporter-reason">Reason</Label>
                  <Input
                    id="supporter-reason"
                    name="reason"
                    required
                    minLength={3}
                    maxLength={200}
                    defaultValue="Checked the payment in PayPal."
                  />
                </div>
              </fieldset>

              {problem ? (
                <Alert variant="destructive">
                  <AlertTitle>
                    {founderBlocked ? "Founder could not be recorded" : "Payment could not be saved"}
                  </AlertTitle>
                  <AlertDescription>{problem}</AlertDescription>
                </Alert>
              ) : null}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => {
                    setOpen(false);
                    resetForAnother();
                  }}
                >
                  Cancel
                </Button>
                {founderBlocked ? (
                  <Button type="button" variant="outline" disabled={saving} onClick={() => void save(false)}>
                    Save without founder
                  </Button>
                ) : null}
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving…" : "Save supporter"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
