# Patreon supporter records

This feature keeps a private Patreon ledger in the UNC dashboard. It records signed membership observations, checked payment receipts, staff identity links, and permanent founder promises. It sends no RCON commands and grants no Discord roles. Existing legacy and seeding access are separate and are never changed by this integration.

## Founder offer

The agreed offer is an initial $5 USD monthly tier. A qualifying first successful payment of at least $5 during the founder window can earn a permanent promise of standard whitelist access when that access launches. The current approved window is **September 30, 2026 at 00:00 EDT, inclusive, through October 15, 2026 at 00:00 EDT, exclusive**. That covers September 30 through October 14.

Window settings must be explicit and exactly 15 days apart. The feature remains disabled by default. Setting the dates does not connect Patreon or activate access.

An administrator must check the completed Patreon receipt and payment history, record its reference, actual amount, currency and payment date, and explicitly confirm it was the first successful payment. An active membership, tier amount, or signed `Paid` status alone cannot establish the transaction amount or qualify a founder. Any earlier known payment blocks qualification pending further investigation. The founder action also requires a staff-reviewed Discord and Steam identity link; this link does not claim OAuth authentication or proof of Steam ownership.

Founder awards are separate permanent records with their own audit and payment reference. Cancellation does not remove them. A later subscription payment is not a new founder qualification. Refund disputes and corrections require staff review; this phase does not automatically revoke promises.

## Connecting the integration

1. The combined launch migration was applied to the identified production database on September 30 under the owner's explicit authorization, and post-deployment schema checks passed; see [Database prerequisite](ADMIN_DASHBOARD.md#database-prerequisite--launch-migration-applied). `PATREON_ENABLED` remains false. Other deployments still require the reviewed schema before activation.
2. Create the Patreon page and identify its real numeric campaign ID. Configure `PATREON_CAMPAIGN_ID`, `PATREON_FOUNDER_START_AT=2026-09-30T00:00:00-04:00` and `PATREON_FOUNDER_END_AT=2026-10-15T00:00:00-04:00`. Launching the website later does not move this approved window.
3. After the database and authenticated staff dashboard are verified, `PATREON_ENABLED=true` enables private manual records for that campaign. The ledger does not require an OAuth token or webhook secret. Without a valid separate signing secret, webhook intake still returns 503.
4. For automatic observations, create a v2 webhook for that campaign. Its direct backend HTTPS destination is `/supporters/webhooks/patreon`; the public website proxy does not forward this route. Subscribe to all six supported events: `members:create`, `members:update`, `members:delete`, `members:pledge:create`, `members:pledge:update`, and `members:pledge:delete`. Configure the webhook's `PATREON_WEBHOOK_SECRET`, separate from RCON, combat feed and session secrets.
5. Confirm a signed portal test delivery appears in the private Supporters page before relying on incoming records. Repeat the same test body to check deduplication, and inspect Patreon for failed or paused deliveries. A configured secret is not proof of working delivery. Tests create only unverified observations; do not treat them as donor payments. Existing supporters are not automatically backfilled.

The backend uses Nest's original raw request body and verifies Patreon's HMAC-MD5 signature in constant time before parsing. It rejects bodies above 64 KiB and campaigns other than the configured one. These are Patreon's documented signature rules; v1 pledge hooks retire on October 7, 2026. Use the [official Patreon v2 webhook documentation](https://docs.patreon.com/#apiv2-webhook-endpoints).

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
