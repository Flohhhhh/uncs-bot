# Patreon supporter records

This feature keeps a private Patreon ledger in the UNC dashboard. It imports the campaign's members and completed payments from the authenticated Patreon API. It also records optional signed webhook observations, checked payment receipts, staff identity links, and permanent founder promises. It sends no RCON commands and grants no Discord roles. Existing legacy and seeding access are separate and are never changed by this integration.

## Founder offer

The agreed offer is an initial $5 USD monthly tier. A qualifying first successful payment of at least $5 during the founder window can earn a permanent promise of standard whitelist access when that access launches. The current approved window is **September 30, 2026 at 00:00 EDT, inclusive, through October 15, 2026 at 00:00 EDT, exclusive**. That covers September 30 through October 14.

Window settings must be explicit and exactly 15 days apart. The feature remains disabled by default. Setting the dates does not connect Patreon or activate access.

A qualifying payment is either of these, and both are treated identically (inside the window, at least $5, in USD):

- a verified **Patreon (API)** payment that the import derived as the member's first successful payment (see [Payments from the import](#payments-from-the-import));
- a staff-checked receipt: an administrator checks the completed Patreon receipt and payment history, records its reference, actual amount, currency and payment date, and explicitly confirms it was the first successful payment.

An active membership, tier amount, or signed webhook `Paid` status alone cannot establish the transaction amount or qualify a founder. Any earlier known payment blocks qualification pending further investigation. The one exception is that an unverified webhook status row cannot block an imported first payment, because the authenticated history already covers that charge.

Awarding remains a staff action. It also requires a staff-reviewed Discord and Steam identity link; this link does not claim OAuth authentication or proof of Steam ownership. A Discord ID filled in by the import does not satisfy this on its own.

Founder awards are separate permanent records with their own audit and payment reference. Cancellation does not remove them. A later subscription payment is not a new founder qualification. Refund disputes and corrections require staff review. When Patreon later reports a founder's qualifying payment as refunded, declined or fraudulent, the import marks that payment unverified and lists the founder under the sync status's `founderReviews`. It never deletes or changes the promise.

## Connecting the integration

1. The combined launch migration was applied to the identified production database on September 30 under the owner's explicit authorization, and post-deployment schema checks passed; see [Database prerequisite](ADMIN_DASHBOARD.md#database-prerequisite--launch-migration-applied). The import needs no further migration: payment `source` and observation `trigger` are plain text columns. Other deployments still require the reviewed schema before activation.
2. Identify the campaign's numeric ID. The UNCs campaign ("The UNCs", vanity `TheUNCs`, created September 30, 2026) is `16880209`. Configure `PATREON_CAMPAIGN_ID`, `PATREON_FOUNDER_START_AT=2026-09-30T00:00:00-04:00` and `PATREON_FOUNDER_END_AT=2026-10-15T00:00:00-04:00`. The end is exclusive, and the dates must be exactly 15 days apart or founder awards stay disabled. Launching the website later does not move this approved window.
3. Signed in to Patreon as the campaign's creator, open [Clients & API Keys](https://www.patreon.com/portal/registration/register-clients) and choose **Create Client**. Use an app name such as `UNCs Gramps supporter sync` and a short description such as "Private read-only import of The UNCs members for the staff dashboard". Choose Client API Version **2** and an HTTPS redirect URI on a domain you control, for example `https://theuncsgaming.com/`; the import never uses the OAuth redirect. Fill any other required fields with The UNCs' details. Do not sign in to this client with the creator account afterwards, because Patreon can then issue a new creator token.
4. Open the new client and copy only the **Creator's Access Token**. The client secret and refresh token are not used and should not be stored in Railway.
5. In Railway set `PATREON_ENABLED=true` and `PATREON_CREATOR_ACCESS_TOKEN=<the token>`. Optionally set `PATREON_SYNC_INTERVAL_MINUTES` (default 30, from 10 to 1440). The token must differ from every other configured secret; a reused or malformed value leaves the import unconfigured and the Supporters page says why.
6. After the redeploy, the first import runs about 15 seconds after startup and then on the interval. On the private Supporters page, the sync status shows the last successful sync, the member count and new payments. Every Patreon member appears as a record pending review. An administrator can also choose **Sync from Patreon** to import immediately.

### Optional webhooks

Webhooks are optional; the import already brings in existing and future patrons. To also record near-real-time signed observations, create a v2 webhook for the campaign. Its direct backend HTTPS destination is `/supporters/webhooks/patreon`; the public website proxy does not forward this route. Subscribe to all six supported events: `members:create`, `members:update`, `members:delete`, `members:pledge:create`, `members:pledge:update`, and `members:pledge:delete`. Configure the webhook's `PATREON_WEBHOOK_SECRET`, separate from the RCON, combat feed and session secrets and from the creator token. Without a valid separate signing secret, webhook intake returns 503.

Confirm a signed portal test delivery appears in the private Supporters page before relying on incoming records. Repeat the same test body to check deduplication, and inspect Patreon for failed or paused deliveries. A configured secret is not proof of working delivery. Tests create only unverified observations; do not treat them as donor payments. Webhooks never backfill existing supporters.

The backend uses Nest's original raw request body and verifies Patreon's HMAC-MD5 signature in constant time before parsing. It rejects bodies above 64 KiB and campaigns other than the configured one. These are Patreon's documented signature rules; v1 pledge hooks retire on October 7, 2026. Use the [official Patreon v2 webhook documentation](https://docs.patreon.com/#apiv2-webhook-endpoints).

## Patreon API import

The import is a read-only `GET /api/oauth2/v2/campaigns/{campaign_id}/members` with `include=user,pledge_history`. It requests only `fields[member]=full_name,patron_status,last_charge_status,last_charge_date`, `fields[user]=social_connections` and `fields[pledge-event]=amount_cents,currency_code,date,payment_status,type`, and no email, address, note or tier data. Of `social_connections`, only the Discord user ID is parsed; other connected accounts are discarded. Hidden or empty names stay allowed.

Requests send the creator token as a Bearer token with a descriptive User-Agent. Each request has a 20-second timeout and follows no redirects. Pages hold 50 members, are paced under Patreon's limit of 100 requests per minute per token, and are capped at 100 pages and 8 MiB each. Responses are validated strictly before anything is written.

Every page is read before anything is imported. A network error, timeout, unexpected response or Patreon outage imports nothing, and keeps the existing records and the previous sync counts. After a `429`, the next attempt waits for Patreon's `Retry-After` (or `retry_after_seconds`). A member whose snapshot is unchanged adds no observation and keeps its review state. A changed member gets an `api:sync` observation and returns to pending review, with the same charge-ordering rules as webhooks.

Syncs are single-flight: the timer and any number of staff clicks share one running sync. A click within 30 seconds of the last attempt shows that result instead of calling Patreon again. Status is kept in memory and resets on restart.

### Payments from the import

Each pledge event with `payment_status` **Paid** becomes one `patreon_api` payment with Patreon's actual amount, currency and date. Its reference is the pledge-event ID, which is unique per campaign and source, so repeated syncs never duplicate it. It is marked **verified** because it comes from the authenticated Patreon record.

The import marks the member's earliest Paid event as the first successful payment only when the returned history looks complete. It treats the history as possibly truncated, and derives nothing, when an event is missing from the response, when the history reaches Patreon's cut-off of roughly 100 events, or when the earliest event is not the pledge start. It also derives nothing when an earlier event was refunded, refund-pending or fraudulent, or when two Paid events share a time. `truncated` in the sync status counts these members; staff can still record a checked receipt for them.

When Patreon later reports an imported payment with any status other than Paid (for example Refunded, Partially Refunded, Declined or Fraud), the payment becomes unverified and loses its first-payment flag. A `patreon-payment-status` audit row records the change. A payment reported Paid again is verified again.

Webhook `signed_status` rows and imported payments describe the same charges but are never added together. Webhook rows stay unverified, have no amount, are never founder-eligible, and cannot block an imported first payment. A record's displayed payment prefers verified evidence, then the latest date. A staff receipt for the same charge stays a separate staff record. It remains eligible on its own, and a receipt dated earlier than an imported payment blocks that imported payment until staff review it.

### Discord accounts

Patreon exposes a patron's Discord user ID only when the campaign has Patreon's Discord integration connected and offered as a tier benefit, and the patron has connected Discord. When the import sees one, it fills in the record's Discord ID if the record has none and no other record in the campaign uses that ID. It then writes a `patreon-discord-link` audit row by `Patreon sync`. It never overwrites an existing link. A different existing link, or an ID already used by another record, is reported under `conflicts` and `conflictDetails` for staff. SteamIDs are always linked by staff.

### Token expiry and renewal

The import does not refresh tokens. Patreon refresh tokens are single-use: each refresh returns a new refresh token and the old one stops working. A refresh that cannot store the rotated tokens would lock the import out.

When Patreon answers `401` or `403`, the status shows `tokenRejected: true` with an instruction to renew the Creator's Access Token on the [client page](https://www.patreon.com/portal/registration/register-clients), update `PATREON_CREATOR_ACCESS_TOKEN` in Railway (which redeploys the bot), and confirm that `PATREON_CAMPAIGN_ID` belongs to that creator. While the token is rejected, scheduled attempts slow to every 6 hours, and existing records are untouched. Patreon says creator tokens for newer clients do not expire, but tokens can still be revoked or rotated, so check the status line after any change to the Patreon client.

### Sync status

`GET /admin/api/supporters` adds a `sync` object; every existing field is unchanged. It contains:

- `configured`, `running`, `lastAttemptAt`, `lastSuccessAt`, `lastError` (fixed, safe text) and `tokenRejected`;
- counts from the last successful sync: `members`, `newMembers`, `updated`, `payments` (new imported payments), `discordLinks`, `conflicts`, `truncated` and `revokedPayments`;
- `memberListComplete`, `intervalMinutes`, `nextAttemptAt`, `conflictDetails` and `founderReviews`.

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

Local tests cover signatures, tampering, campaign checks, privacy, role/CSRF enforcement, replay, ordering and founder eligibility. Import tests use a mocked `fetch` with no network. They cover pagination, schema rejection, 401/403 and 429 handling, idempotent re-syncs, payment dedupe, first-payment derivation, refunds, founder eligibility for imported payments, Discord link fill, no-overwrite and conflicts, single-flight, and that the token stays out of status, errors and logs. Persistence tests inspect generated PostgreSQL queries and transaction behavior, and the isolated PostgreSQL suite exercises an import end to end. Production migration execution and schema checks are complete; a real Patreon import, webhook delivery and authenticated staff use still need deployment verification.
