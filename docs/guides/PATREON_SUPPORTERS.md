# Supporter records (Patreon and PayPal)

This feature keeps a private supporter ledger in the UNC dashboard. It records signed Patreon membership observations, checked Patreon receipts, staff-checked PayPal payments, staff identity links, and permanent founder promises. It sends no RCON commands and grants no Discord roles. Existing legacy and seeding access are separate and are never changed by this integration.

## Why the Supporters page can show 0 records

The page lists Patreon records only for the configured campaign. With `PATREON_ENABLED` or `PATREON_CAMPAIGN_ID` unset, it now shows the PayPal ledger alone (earlier releases showed nothing at all). No webhook backfills earlier patrons, so existing Patreon supporters appear only after they are recorded by staff, by a signed webhook delivery, or by the separate Patreon API import. A founder window that was never configured (see below) also blocks every founder award.

## Founder offer

The agreed offer is an initial $5 USD monthly tier. A qualifying first successful payment of at least US$5 during the founder window can earn a permanent promise of standard whitelist access when that access launches. The current approved window is **September 30, 2026 at 00:00 EDT, inclusive, through October 15, 2026 at 00:00 EDT, exclusive**. That covers September 30 through October 14.

There is one founder level. The rule is the same for every provider. A payment qualifies when:

- it comes from a qualifying verified source: a staff-checked Patreon receipt (`manual_receipt`), an authenticated Patreon API import (`patreon_api`), or a staff-checked PayPal payment (`paypal`). A signed Patreon `Paid` status (`signed_status`) never qualifies on its own;
- staff (or the API import) confirmed it was the supporter's first successful payment, and no earlier payment of any source is recorded for that supporter;
- it was paid inside the window (start inclusive, end exclusive);
- it is at least US$5. A payment in another currency qualifies only when staff confirm it was worth at least US$5 (`minimumConfirmed`). Amount and currency are recorded but never create tiers.

The founder also needs **at least one** staff-linked identity: a Discord account ID or a valid SteamID64. A SteamID that is entered must be a valid player ID. This relaxes the earlier rule, which required both a Discord and a Steam link. Each person can be a founder once: a founder promise is refused when another supporter record (Patreon or PayPal) with the same Discord ID or SteamID already holds one. The link does not claim OAuth authentication or proof of Steam ownership.

An administrator must check the completed receipt and payment history, record its reference, actual amount, currency and payment date, and explicitly confirm it was the first successful payment. An active membership, tier amount, or signed `Paid` status alone cannot establish the transaction amount or qualify a founder. When a founder action is refused, the response names the rule (`blockedReason`), for example `outside_window` or `earlier_payment`, and nothing is recorded. Each supporter row also reports `founderBlockedReason`, and a founder without a linked Discord account is flagged with `needsDiscordLink`.

Founder awards are separate permanent records with their own audit and payment reference. Cancellation does not remove them. A later subscription payment is not a new founder qualification. Refund disputes and corrections require staff review; this phase does not automatically revoke promises.

### Founder window settings

Set the window with `SUPPORTER_FOUNDER_START_AT` and `SUPPORTER_FOUNDER_END_AT`, or with the original `PATREON_FOUNDER_START_AT` and `PATREON_FOUNDER_END_AT`, which are still read. Use the exclusive end:

```
PATREON_FOUNDER_START_AT=2026-09-30T00:00:00-04:00
PATREON_FOUNDER_END_AT=2026-10-15T00:00:00-04:00
```

A complete `SUPPORTER_FOUNDER_*` pair wins. If both pairs are complete they must name the same instants, and a half-set pair is never ignored: either mistake leaves the window unconfigured. The two times must be exactly 15 days apart, so never end the window at `23:59:59` on October 14. The list response reports which pair was used as `founderPolicy.source`. Setting the dates does not connect Patreon or activate access.

## Connecting the integration

1. The combined launch migration was applied to the identified production database on September 30 under the owner's explicit authorization, and post-deployment schema checks passed; see [Database prerequisite](ADMIN_DASHBOARD.md#database-prerequisite--launch-migration-applied). `PATREON_ENABLED` remains false. Other deployments still require the reviewed schema before activation.
2. Create the Patreon page and identify its real numeric campaign ID. Configure `PATREON_CAMPAIGN_ID`, `PATREON_FOUNDER_START_AT=2026-09-30T00:00:00-04:00` and `PATREON_FOUNDER_END_AT=2026-10-15T00:00:00-04:00`. Launching the website later does not move this approved window.
3. After the database and authenticated staff dashboard are verified, `PATREON_ENABLED=true` enables private manual records for that campaign. The ledger does not require an OAuth token or webhook secret. Without a valid separate signing secret, webhook intake still returns 503.
4. For automatic observations, create a v2 webhook for that campaign. Its direct backend HTTPS destination is `/supporters/webhooks/patreon`; the public website proxy does not forward this route. Subscribe to all six supported events: `members:create`, `members:update`, `members:delete`, `members:pledge:create`, `members:pledge:update`, and `members:pledge:delete`. Configure the webhook's `PATREON_WEBHOOK_SECRET`, separate from RCON, combat feed and session secrets.
5. Confirm a signed portal test delivery appears in the private Supporters page before relying on incoming records. Repeat the same test body to check deduplication, and inspect Patreon for failed or paused deliveries. A configured secret is not proof of working delivery. Tests create only unverified observations; do not treat them as donor payments. Existing supporters are not automatically backfilled.

The backend uses Nest's original raw request body and verifies Patreon's HMAC-MD5 signature in constant time before parsing. It rejects bodies above 64 KiB and campaigns other than the configured one. These are Patreon's documented signature rules; v1 pledge hooks retire on October 7, 2026. Use the [official Patreon v2 webhook documentation](https://docs.patreon.com/#apiv2-webhook-endpoints).

## Recording PayPal supporters

PayPal supporters are recorded by an administrator after checking the completed payment in PayPal. There is no PayPal connection or webhook, and no payer email or PayPal account details are stored. This works whether or not Patreon is configured.

**Database prerequisite:** the PayPal ledger adds `supporter_members.provider`, makes the Patreon-only IDs nullable, and adds `supporter_payments.minimum_confirmed`, `supporter_payments.recorded_by`, three partial unique indexes and four check constraints. A human contributor must generate and review that migration (combined with any other pending schema change) before this release is deployed. Existing rows default to `provider = patreon` and already satisfy every check.

`POST /admin/api/supporters/paypal` (admin only, same-origin CSRF, the supporter request limit) accepts:

| Field | Meaning |
| --- | --- |
| `id` | A new action UUID. Reuse it when retrying the same request. |
| `memberId`, `version` | Optional. Attach the payment to this existing PayPal supporter; the current `version` is required. |
| `displayName` | 1–120 characters. Used only when a new supporter is created; it never renames an existing one. |
| `discordId`, `steamId` | Optional. The Discord ID is needed for the Founder role. |
| `paidAt` | The completed payment time with an offset, not more than five minutes in the future. |
| `amountCents`, `currency` | The actual amount in minor units and a three-letter currency code. |
| `transactionId` | The PayPal transaction ID, 10–30 letters and digits. Stored upper-cased. |
| `completedPaymentVerified` | Must be `true`: you checked this completed payment in PayPal. |
| `firstSuccessfulPaymentVerified` | Whether this was their first payment to The UNCs. |
| `minimumConfirmed` | For a non-USD payment: you confirmed it was worth at least US$5. |
| `awardFounder` | Record the founder promise now if the payment qualifies. |
| `reason` | 3–200 characters. |

Without `memberId`, the payment attaches to the PayPal supporter with the same Discord ID, then the same SteamID, or a new PayPal supporter is created. An identity that conflicts with an account already linked to that supporter is refused; use **Link** to change it. Empty identity fields are filled in.

The supporter, payment, optional founder promise and audit record commit together. If `awardFounder` is set and the payment does not qualify, the response is 409 with the `blockedReason` and nothing is recorded. Retries are safe: the same action ID from the same administrator returns the original result, and a transaction ID that is already recorded with the same supporter, amount, currency and time returns the existing records without writing again. Different details for a recorded transaction ID are refused; search the transaction ID instead. The response is `{ok, replayed, supporter, payment, founder: {awarded, eligible, blockedReason}}`.

PayPal rows report `provider: "paypal"` and `patreonMemberId: null`. Every supporter row now has a `confirmKey`: send it as `confirm` in Link, Review and Founder actions. It equals the Patreon member ID for Patreon rows and the record ID for PayPal rows. Recording a Patreon receipt on a PayPal supporter is refused. `GET /admin/api/supporters?provider=paypal|patreon` filters the list, and search also matches PayPal transaction IDs.

## Recording earlier supporters

Use **Record existing Patreon member** when someone supported the campaign before webhooks were connected. Enter their actual Patreon membership resource ID from verified v2 API data or a signed webhook, an optional name and a staff reason, and confirm that you checked the membership belongs to The UNCs campaign. The membership ID is distinct from a creator/user ID, tier ID or username. Patreon documents member resources and an authenticated campaign-members lookup in its [v2 API reference](https://docs.patreon.com/#get-api-oauth2-v2-campaigns-campaign_id-members). Hidden or empty names are allowed and do not identify an account by themselves.

The creator dashboard and CSV export have not been verified to expose this API membership ID, and this application does not fetch it automatically. If verified v2 member data or a signed webhook is not yet available, keep the donor's payment evidence in Patreon until the real membership ID can be obtained. Do not substitute a profile/user ID or invent a placeholder to bypass that requirement.

This action creates an unverified member shell and a durable staff audit in one transaction. It creates no signed observation, payment or founder record, and cannot overwrite a membership already recorded. Repeating the same action ID is accepted only for the same staff member and exact input. After an uncertain result, refresh and search for the membership before submitting a new entry.

The dashboard initially shows at most 100 recent records. **Search all records** searches the complete configured campaign ledger by name, Patreon membership ID, Discord ID or SteamID and returns at most 100 matches. Submit an explicit search to find earlier donors; narrowing an account ID is useful if a broad name search reaches the cap. Search input is bounded and sent only on submission.

Review the member's **complete payment history**, including earlier successful payments, before recording a receipt or checking the first-payment box. Patreon provides this under Creator studio → Audience → member → See all payment history. Verify actual completed amount, USD currency and payment time; tier price, active membership and current entitlement are insufficient. Patreon displays some dates in the viewer's local timezone, so reconcile the September 30 and October 15 boundaries against the explicit EDT window. See [payment history](https://support.patreon.com/hc/en-us/articles/360034415031-View-members-payment-history) and [subscription billing dates](https://support.patreon.com/hc/en-gb/articles/8779192853261-Subscription-billing-FAQ).

Manual entry does not replace a complete campaign reconciliation: compare the creator's member/payment records with the ledger, including members who canceled after paying. Record receipt evidence and identity links separately, then award an eligible founder promise. Cancellation still cannot erase an existing founder promise.

## Reliability and privacy

Patreon's signature covers the body, not the event header. A durable body digest deduplicates retries independently of that header. Observation insertion and member updates are one transaction; staff actions have durable, actor-bound replay protection and record-version checks.

Webhooks do not establish a trustworthy delivery order. New observations always require review. Older charge dates cannot replace newer charge data, and undated updates preserve the last known charge date. Membership observations are not automatic entitlement decisions. A delayed first-seen payload can still represent old membership state; checking Patreon remains necessary.

Only administrators can read or edit this ledger. Mutations require the existing fresh role check, exact website origin and session CSRF token. The integration stores selected member/status fields and private payment references, not raw payloads, email addresses, postal addresses, card details or creator notes. Dashboard and proxy responses use no-store headers. The payment and audit ledger currently has no automatic purge; include it in the deployment's access, backup and retention decisions.

Local tests cover signatures, tampering, campaign checks, privacy, role/CSRF enforcement, replay, ordering and founder eligibility. Persistence tests inspect generated PostgreSQL queries and transaction behavior. Production migration execution and schema checks are complete; real Patreon delivery and authenticated staff use still need deployment verification.
