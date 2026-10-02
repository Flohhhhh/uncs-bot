# Supporter records (Patreon and PayPal)

This feature keeps a private supporter ledger in the UNC dashboard. It imports the Patreon campaign's members and completed payments from the authenticated Patreon API, and records optional signed Patreon webhook observations, checked Patreon receipts, staff-checked PayPal payments, identity links, and permanent founder promises. It sends no RCON commands. When [automatic Discord roles](DISCORD_ROLES.md) are switched on, founders with a linked Discord account receive the Founder role, including a Discord account that the Patreon import filled in, and people who currently support can receive the [Supporter role](#supporter-role). Existing legacy and seeding access are separate and are never changed by this integration.

## Why the Supporters page can show 0 records

The page lists Patreon records only for the configured campaign. With `PATREON_ENABLED` or `PATREON_CAMPAIGN_ID` unset, it now shows the PayPal ledger alone (earlier releases showed nothing at all). No webhook backfills earlier patrons, so existing Patreon supporters appear only after the Patreon API import runs (see [Connecting the integration](#connecting-the-integration)), or after staff or a signed webhook delivery record them. A founder window that was never configured (see below) also blocks every founder award.

## Founder offer

The agreed offer is an initial $5 USD monthly tier. A qualifying first successful payment of at least US$5 during the founder window can earn a permanent promise of standard whitelist access when that access launches. The current approved window is **September 30, 2026 at 00:00 EDT, inclusive, through October 15, 2026 at 00:00 EDT, exclusive**. That covers September 30 through October 14.

There is one founder level. The rule is the same for every provider. A payment qualifies when:

- it comes from a qualifying verified source: a staff-checked Patreon receipt (`manual_receipt`), a payment from the authenticated Patreon API import (`patreon_api`), or a staff-checked PayPal payment (`paypal`). A signed Patreon webhook `Paid` status (`signed_status`) never qualifies on its own;
- it was the supporter's first successful payment: staff confirmed this for a receipt or PayPal payment, or the import derived it (see [Payments from the import](#payments-from-the-import)), and no earlier payment is recorded for that supporter, apart from the two exceptions below;
- it was paid inside the window (start inclusive, end exclusive);
- it is at least US$5. A payment in another currency qualifies only when staff confirm it was worth at least US$5 (`minimumConfirmed`). Amount and currency are recorded but never create tiers.

Any earlier known payment, from any source, blocks qualification pending further investigation, with two exceptions. An unverified webhook status row cannot block an imported first payment, because the authenticated history already covers that charge. A staff receipt is not blocked by the imported copy of its own charge, but it stops qualifying if Patreon later reports that copy as anything other than Paid (see [Payments from the import](#payments-from-the-import)).

The founder also needs **at least one** linked identity: a Discord account ID or a valid SteamID64. A SteamID that is entered must be a valid player ID. This relaxes the earlier rule, which required both a Discord and a Steam link. A Discord ID that the Patreon import filled in counts as a linked identity, so a patron who connected Discord on Patreon can be awarded without a separate staff link. Each person can be a founder once: a founder promise is refused when another supporter record (Patreon or PayPal) with the same Discord ID or SteamID already holds one. The link does not claim OAuth authentication or proof of Steam ownership.

For a receipt, an administrator must check the completed receipt and payment history, record its reference, actual amount, currency and payment date, and explicitly confirm it was the first successful payment. An active membership, tier amount, or signed `Paid` status alone cannot establish the transaction amount or qualify a founder. Awarding is always a staff action. When a founder action is refused, the response names the rule (`blockedReason`), for example `outside_window` or `earlier_payment`, and nothing is recorded. A receipt whose imported copy Patreon no longer reports as paid is refused as `not_verified`. Each supporter row also reports `founderBlockedReason`, and a founder without a linked Discord account is flagged with `needsDiscordLink`.

The current dashboard offers the founder award only for a staff receipt. A founder whose only qualifying payment is imported is awarded through `POST /admin/api/supporters/:id/founder` with that payment's ID, and a PayPal founder through the PayPal record, until the dashboard redesign supports both.

Founder awards are separate permanent records with their own audit and payment reference. Cancellation does not remove them. A later subscription payment is not a new founder qualification. Refund disputes and corrections require staff review. When Patreon later reports a founder's qualifying payment as refunded, declined or fraudulent, the import marks that payment unverified and lists the founder under the sync status's `founderReviews`. This includes a founder awarded on a staff receipt: the founder is listed when any imported payment dated in the founder window, widened by 36 hours on each side, is no longer verified. The import never deletes or changes the promise.

### Supporter role

The founder window covers September 30 through October 14, 2026 (Eastern). People who support after that are recognised with an optional **Supporter** Discord role instead. It needs `DISCORD_SUPPORTER_ROLE_ID` and the [automatic Discord roles](DISCORD_ROLES.md#the-supporter-role) switched on.

The Supporter role is a Discord role only. It does not grant whitelist access, queue priority or any other in-game reward, and it does not change founder promises. Gramps adds it while a supporter with a linked Discord account supports right now, and removes it when that support ends:

- a Patreon patron counts while Patreon reports them active, their latest charge was not refunded or reversed, and at least one completed payment is on record. Patreon charges the tier price itself, so any tier counts in any currency. After a declined charge the role stays for 7 days while Patreon retries the card;
- a PayPal supporter counts for 31 days after each payment of at least US$5 that staff record. A payment in another currency counts when staff confirm it was worth at least US$5 (`minimumConfirmed`).

Patreon payments come from the Patreon API import (or a staff receipt), so Patreon supporters need the import configured. Only records of the configured campaign count; while Patreon is switched off, Patreon records do not count.

A founder who still supports holds both roles. A founder who stops supporting keeps Founder and loses Supporter. Gramps removes only a Supporter role it added itself; a role staff gave by hand stays, including one staff give back after removing the one Gramps added.

### Founder window settings

Set the window with `SUPPORTER_FOUNDER_START_AT` and `SUPPORTER_FOUNDER_END_AT`, or with the original `PATREON_FOUNDER_START_AT` and `PATREON_FOUNDER_END_AT`, which are still read. Use the exclusive end:

```
PATREON_FOUNDER_START_AT=2026-09-30T00:00:00-04:00
PATREON_FOUNDER_END_AT=2026-10-15T00:00:00-04:00
```

A complete `SUPPORTER_FOUNDER_*` pair wins. If both pairs are complete they must name the same instants, and a half-set pair is never ignored: either mistake leaves the window unconfigured. The two times must be exactly 15 days apart, so never end the window at `23:59:59` on October 14. The list response reports which pair was used as `founderPolicy.source`. Setting the dates does not connect Patreon or activate access.

## Connecting the integration

1. The combined launch migration was applied to the identified production database on September 30 under the owner's explicit authorization, and post-deployment schema checks passed; see [Database prerequisite](ADMIN_DASHBOARD.md#database-prerequisite--launch-migration-applied). The import itself needs no further migration: payment `source` and observation `trigger` are plain text columns. The PayPal ledger and automatic Discord roles in this release do need one reviewed migration first (see [Recording PayPal supporters](#recording-paypal-supporters) and the [Discord roles rollout](DISCORD_ROLES.md#rollout)). Other deployments still require the reviewed schema before activation.
2. Identify the campaign's numeric ID. The UNCs campaign ("The UNCs", vanity `TheUNCs`, created September 30, 2026) is `16880209`. Configure `PATREON_CAMPAIGN_ID`, `PATREON_FOUNDER_START_AT=2026-09-30T00:00:00-04:00` and `PATREON_FOUNDER_END_AT=2026-10-15T00:00:00-04:00`. The end is exclusive, and the dates must be exactly 15 days apart or founder awards stay disabled. Launching the website later does not move this approved window.
3. Signed in to Patreon as the campaign's creator, open [Clients & API Keys](https://www.patreon.com/portal/registration/register-clients) and choose **Create Client**. Use an app name such as `UNCs Gramps supporter sync` and a short description such as "Private read-only import of The UNCs members for the staff dashboard". Choose Client API Version **2** and an HTTPS redirect URI on a domain you control, for example `https://theuncsgaming.com/`; the import never uses the OAuth redirect. Fill any other required fields with The UNCs' details. Do not sign in to this client with the creator account afterwards, because Patreon can then issue a new creator token.
4. Open the new client and copy only the **Creator's Access Token**. The client secret and refresh token are not used and should not be stored in Railway.
5. In Railway set `PATREON_ENABLED=true` and `PATREON_CREATOR_ACCESS_TOKEN=<the token>`. Optionally set `PATREON_SYNC_INTERVAL_MINUTES` (default 30, from 10 to 1440). The token must differ from every other configured secret; a reused or malformed value leaves the import unconfigured and the Supporters page says why.
6. After the redeploy, the first import runs about 15 seconds after startup and then on the interval. On the private Supporters page, the sync status shows the last successful sync, the member count and new payments. Every Patreon member appears as a record pending review. An administrator can also choose **Sync from Patreon** to import immediately.

### Optional webhooks

Webhooks are optional; the import already brings in existing and future patrons. To also record near-real-time signed observations, create a v2 webhook for the campaign. Its direct backend HTTPS destination is `/supporters/webhooks/patreon`; the public website proxy does not forward this route. Subscribe to all six supported events: `members:create`, `members:update`, `members:delete`, `members:pledge:create`, `members:pledge:update`, and `members:pledge:delete`. Configure the webhook's `PATREON_WEBHOOK_SECRET`, separate from the RCON, combat feed and session secrets and from the creator token. Without a valid separate signing secret, webhook intake returns 503.

Confirm a signed portal test delivery appears in the private Supporters page before relying on incoming records. Repeat the same test body to check deduplication, and inspect Patreon for failed or paused deliveries. A configured secret is not proof of working delivery. Tests create only unverified observations; do not treat them as donor payments. Webhooks never backfill existing supporters.

The backend uses Nest's original raw request body and verifies Patreon's HMAC-MD5 signature in constant time before parsing. It rejects bodies above 64 KiB and campaigns other than the configured one. These are Patreon's documented signature rules; v1 pledge hooks retire on October 7, 2026. Use the [official Patreon v2 webhook documentation](https://docs.patreon.com/#apiv2-webhook-endpoints).

## Recording PayPal supporters

PayPal supporters are recorded by an administrator after checking the completed payment in PayPal. There is no PayPal connection or webhook, and no payer email or PayPal account details are stored. This works whether or not Patreon is configured.

**Database prerequisite:** the PayPal ledger adds `supporter_members.provider`, makes the Patreon-only IDs nullable, and adds `supporter_payments.minimum_confirmed`, `supporter_payments.recorded_by`, three partial unique indexes and four check constraints. A human contributor must generate and review that migration (combined with any other pending schema change) before this release is deployed. Existing rows default to `provider = patreon` and already satisfy every check.

`POST /admin/api/supporters/paypal` (admin only, same-origin CSRF, the supporter request limit) accepts:

| Field                            | Meaning                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `id`                             | A new action UUID. Reuse it when retrying the same request.                                        |
| `memberId`, `version`            | Optional. Attach the payment to this existing PayPal supporter; the current `version` is required. |
| `displayName`                    | 1–120 characters. Used only when a new supporter is created; it never renames an existing one.     |
| `discordId`, `steamId`           | Optional. The Discord ID is needed for the Founder role.                                           |
| `paidAt`                         | The completed payment time with an offset, not more than five minutes in the future.               |
| `amountCents`, `currency`        | The actual amount in minor units and a three-letter currency code.                                 |
| `transactionId`                  | The PayPal transaction ID, 10–30 letters and digits. Stored upper-cased.                           |
| `completedPaymentVerified`       | Must be `true`: you checked this completed payment in PayPal.                                      |
| `firstSuccessfulPaymentVerified` | Whether this was their first payment to The UNCs.                                                  |
| `minimumConfirmed`               | For a non-USD payment: you confirmed it was worth at least US$5.                                   |
| `awardFounder`                   | Record the founder promise now if the payment qualifies.                                           |
| `reason`                         | 3–200 characters.                                                                                  |

Without `memberId`, the payment attaches to the PayPal supporter with the same Discord ID, then the same SteamID, or a new PayPal supporter is created. An identity that conflicts with an account already linked to that supporter is refused; use **Link** to change it. Empty identity fields are filled in.

The supporter, payment, optional founder promise and audit record commit together. If `awardFounder` is set and the payment does not qualify, the response is 409 with the `blockedReason` and nothing is recorded. Retries are safe: the same action ID from the same administrator returns the original result, and a transaction ID that is already recorded with the same supporter, amount, currency and time returns the existing records without writing again. Different details for a recorded transaction ID are refused; search the transaction ID instead. The response is `{ok, replayed, supporter, payment, founder: {awarded, eligible, blockedReason}}`.

PayPal rows report `provider: "paypal"` and `patreonMemberId: null`. Every supporter row now has a `confirmKey`: send it as `confirm` in Link, Review and Founder actions. It equals the Patreon member ID for Patreon rows and the record ID for PayPal rows. Recording a Patreon receipt on a PayPal supporter is refused. `GET /admin/api/supporters?provider=paypal|patreon` filters the list, and search also matches PayPal transaction IDs.

## Patreon API import

The import is a read-only `GET /api/oauth2/v2/campaigns/{campaign_id}/members` with `include=user,pledge_history`. It requests only `fields[member]=full_name,patron_status,last_charge_status,last_charge_date`, `fields[user]=social_connections` and `fields[pledge-event]=amount_cents,currency_code,date,payment_status,type`, and no email, address, note or tier data. Of `social_connections`, only the Discord user ID is parsed; other connected accounts are discarded. Hidden or empty names stay allowed.

Requests send the creator token as a Bearer token with a descriptive User-Agent. Each request has a 20-second timeout and follows no redirects. Pages hold 50 members, are paced under Patreon's limit of 100 requests per minute per token, and are capped at 100 pages and 8 MiB each. Responses are validated strictly before anything is written.

Every page is read before anything is imported. A network error, timeout, unexpected response or Patreon outage imports nothing, and keeps the existing records and the previous sync counts. After a `429`, the next attempt waits for Patreon's `Retry-After` (or `retry_after_seconds`). A member whose snapshot is unchanged adds no observation and keeps its review state. A changed member gets an `api:sync` observation and returns to pending review, with the same charge-ordering rules as webhooks.

Syncs are single-flight: the timer and any number of staff clicks share one running sync. A click within 30 seconds of the last attempt shows that result instead of calling Patreon again. Status is kept in memory and resets on restart.

### Payments from the import

Each pledge event with `payment_status` **Paid** becomes one `patreon_api` payment with Patreon's actual amount, currency and date. Its reference is the pledge-event ID, which is unique per campaign and source, so repeated syncs never duplicate it. It is marked **verified** because it comes from the authenticated Patreon record.

The import marks the member's earliest Paid event as the first successful payment only when the returned history looks complete. It treats the history as possibly truncated, and derives nothing, when an event is missing from the response, when the history reaches Patreon's cut-off of roughly 100 events, or when the earliest event is not the pledge start. It also derives nothing when an earlier event was refunded, refund-pending or fraudulent, or when two Paid events share a time. `truncated` in the sync status counts these members; staff can still record a checked receipt for them, and the imported copy of that charge does not block the receipt.

When Patreon later reports an imported payment with any status other than Paid (for example Refunded, Partially Refunded, Declined or Fraud), the payment becomes unverified and loses its first-payment flag. A `patreon-payment-status` audit row records the change. A payment reported Paid again is verified again.

Webhook `signed_status` rows and imported payments describe the same charges but are never added together. Webhook rows stay unverified, have no amount, are never founder-eligible, and cannot block an imported first payment. A record's displayed payment prefers verified evidence, then a qualifying source over a webhook row, then the latest date. A staff receipt for the same charge stays a separate staff record and remains eligible on its own. Its imported copy is the imported payment with the receipt's amount and currency that is closest in time to it, within 36 hours either side; this allows for a receipt time estimated from Patreon's date-only history. That copy never counts as an earlier payment for the receipt, but any other earlier payment still blocks it. If Patreon later reports the copy as anything other than Paid, the receipt is no longer founder-eligible. When a receipt and an imported payment both qualify, the record shows the receipt. A receipt dated earlier than an imported payment still blocks that imported payment until staff review it.

### Discord accounts

Patreon exposes a patron's Discord user ID only when the campaign has Patreon's Discord integration connected and offered as a tier benefit, and the patron has connected Discord. When the import sees one, it fills in the record's Discord ID if the record has none and no other record in the campaign uses that ID. It then writes a `patreon-discord-link` audit row by `Patreon sync`. It never overwrites an existing link. A different existing link, or an ID already used by another record, is reported under `conflicts` and `conflictDetails` for staff. SteamIDs are always linked by staff. When [automatic Discord roles](DISCORD_ROLES.md) are on, each Discord ID the import fills in is queued for a role check like a staff link, so a founder whose Discord ID came from Patreon receives the Founder role without waiting for the six-hour safety pass.

### Token expiry and renewal

The import does not refresh tokens. Patreon refresh tokens are single-use: each refresh returns a new refresh token and the old one stops working. A refresh that cannot store the rotated tokens would lock the import out.

When Patreon answers `401` or `403`, the status shows `tokenRejected: true` with an instruction to renew the Creator's Access Token on the [client page](https://www.patreon.com/portal/registration/register-clients), update `PATREON_CREATOR_ACCESS_TOKEN` in Railway (which redeploys the bot), and confirm that `PATREON_CAMPAIGN_ID` belongs to that creator. While the token is rejected, scheduled attempts slow to every 6 hours, and existing records are untouched. Patreon says creator tokens for newer clients do not expire, but tokens can still be revoked or rotated, so check the status line after any change to the Patreon client.

### Sync status

`GET /admin/api/supporters` adds a `sync` object; every existing field is unchanged. It contains:

- `configured`, `running`, `lastAttemptAt`, `lastSuccessAt`, `lastError` (fixed, safe text) and `tokenRejected`;
- counts from the last successful sync: `members`, `newMembers`, `updated`, `payments` (new imported payments), `discordLinks`, `conflicts`, `truncated` and `revokedPayments`;
- `memberListComplete`, `intervalMinutes`, `nextAttemptAt`, `conflictDetails` and `founderReviews`. Each founder review names the founder's qualifying payment (`paymentId`, `paymentSource`, `reference`) and the payment that is no longer verified (`unverifiedPaymentId`, `unverifiedReference`).

`POST /admin/api/supporters/sync` runs or joins a sync and returns `{ ok, joined, recent?, sync }`. It is limited to administrators, with the same session, origin, CSRF and rate limits as other supporter changes, and returns 503 while the import is not configured. The token never appears in responses, errors or logs.

Sources: the Patreon API documentation at [docs.patreon.com](https://docs.patreon.com/#get-api-oauth2-v2-campaigns-campaign_id-members), sections "APIv2: Resource Endpoints" (campaign members, includes and page size), "APIv2: Resources" (Member, Pledge Event and User v2 attributes), "More Data, Pagination", "Rate Limits", "Errors" and "Clients and API Keys". Details the docs do not state come from Patreon developer forum answers: the `fields[pledge-event]` parameter name, histories cut to roughly the latest 100 events on large pages, single-use refresh tokens, non-expiring creator tokens for newer clients, and the Discord benefit requirement.

## Recording earlier supporters

The import is the recommended way to bring in existing supporters. **Record existing Patreon member** remains a fallback for when the import cannot be configured. Enter the member's actual Patreon membership resource ID from verified v2 API data or a signed webhook, an optional name and a staff reason, and confirm that you checked the membership belongs to The UNCs campaign. The membership ID is distinct from a creator/user ID, tier ID or username. Patreon documents member resources and an authenticated campaign-members lookup in its [v2 API reference](https://docs.patreon.com/#get-api-oauth2-v2-campaigns-campaign_id-members). Hidden or empty names are allowed and do not identify an account by themselves.

The creator dashboard and CSV export have not been verified to expose this API membership ID; the import records it automatically. If neither the import nor a signed webhook is available, keep the donor's payment evidence in Patreon until the real membership ID can be obtained. Do not substitute a profile/user ID or invent a placeholder to bypass that requirement. The next import matches a manual record that has the real membership ID instead of duplicating it.

This action creates an unverified member shell and a durable staff audit in one transaction. It creates no signed observation, payment or founder record, and cannot overwrite a membership already recorded. Repeating the same action ID is accepted only for the same staff member and exact input. After an uncertain result, refresh and search for the membership before submitting a new entry.

The dashboard initially shows at most 100 recent records. **Search all records** searches the complete configured campaign ledger by name, Patreon membership ID, Discord ID or SteamID and returns at most 100 matches. Submit an explicit search to find earlier donors; narrowing an account ID is useful if a broad name search reaches the cap. Search input is bounded and sent only on submission.

Before recording a receipt or checking the first-payment box, review the member's **complete payment history**, including earlier successful payments. Patreon provides this under Creator studio → Audience → member → See all payment history. Verify actual completed amount, USD currency and payment time; tier price, active membership and current entitlement are insufficient. Patreon displays some dates in the viewer's local timezone, so reconcile the September 30 and October 15 boundaries against the explicit EDT window. See [payment history](https://support.patreon.com/hc/en-us/articles/360034415031-View-members-payment-history) and [subscription billing dates](https://support.patreon.com/hc/en-gb/articles/8779192853261-Subscription-billing-FAQ).

Manual entry does not replace a complete campaign reconciliation: compare the creator's member/payment records with the ledger, including members who canceled after paying. Record receipt evidence and identity links separately, then award an eligible founder promise. Cancellation still cannot erase an existing founder promise.

## Reliability and privacy

Patreon's signature covers the body, not the event header. A durable body digest deduplicates retries independently of that header. Observation insertion and member updates are one transaction; staff actions have durable, actor-bound replay protection and record-version checks. Each imported member is written in its own transaction.

Webhooks do not establish a trustworthy delivery order. New observations always require review. Older charge dates cannot replace newer charge data, and undated updates preserve the last known charge date. Membership observations are not automatic entitlement decisions. A delayed first-seen payload can still represent old membership state; checking Patreon remains necessary.

Only administrators can read or edit this ledger. Mutations, including **Sync from Patreon**, require the existing fresh role check, exact website origin and session CSRF token. The integration stores selected member and status fields, pledge-event payment references and, where Patreon provides it, a connected Discord ID. It does not store raw payloads, email addresses, postal addresses, card details, other connected accounts or creator notes. The creator token stays in the environment only. Dashboard and proxy responses use no-store headers. The payment and audit ledger currently has no automatic purge; include it in the deployment's access, backup and retention decisions.

Local tests cover signatures, tampering, campaign checks, privacy, role/CSRF enforcement, replay, ordering and founder eligibility. Import tests use a mocked `fetch` with no network. They cover pagination, schema rejection, 401/403 and 429 handling, idempotent re-syncs, payment dedupe, first-payment derivation, refunds, founder eligibility for imported payments and for staff receipts beside the imported copy of their charge, founder reviews after a refund, Discord link fill, no-overwrite and conflicts, single-flight, and that the token stays out of status, errors and logs. Persistence tests inspect generated PostgreSQL queries and transaction behavior, and the isolated PostgreSQL suite exercises an import end to end. Production migration execution and schema checks are complete; a real Patreon import, webhook delivery and authenticated staff use still need deployment verification.
