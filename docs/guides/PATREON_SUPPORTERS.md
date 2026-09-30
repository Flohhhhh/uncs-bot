# Patreon supporter records

This feature keeps a private Patreon ledger in the UNC dashboard. It records signed membership observations, checked payment receipts, staff identity links, and permanent founder promises. It sends no RCON commands and grants no Discord roles. Existing legacy and seeding access are separate and are never changed by this integration.

## Founder offer

The agreed offer is an initial $5 USD monthly tier. A qualifying first successful payment of at least $5 during the founder window can earn a permanent promise of standard whitelist access when that access launches. The current approved window is **September 30, 2026 at 00:00 EDT, inclusive, through October 15, 2026 at 00:00 EDT, exclusive**. That covers September 30 through October 14.

Window settings must be explicit and exactly 15 days apart. The feature remains disabled by default. Setting the dates does not connect Patreon or activate access.

An administrator must check the completed Patreon receipt and payment history, record its reference, actual amount, currency and payment date, and explicitly confirm it was the first successful payment. An active membership, tier amount, or signed `Paid` status alone cannot establish the transaction amount or qualify a founder. Any earlier known payment blocks qualification pending further investigation. The founder action also requires a staff-reviewed Discord and Steam identity link; this link does not claim OAuth authentication or proof of Steam ownership.

Founder awards are separate permanent records with their own audit and payment reference. Cancellation does not remove them. A later subscription payment is not a new founder qualification. Refund disputes and corrections require staff review; this phase does not automatically revoke promises.

## Connecting the integration

1. The combined launch migration was applied to the identified production database on September 30 under the owner's explicit authorization, and post-deployment schema checks passed; see [Database prerequisite](ADMIN_DASHBOARD.md#database-prerequisite--launch-migration-applied). `PATREON_ENABLED` remains false. Other deployments still require the reviewed schema before activation.
2. Create the Patreon page and a v2 webhook for the correct campaign. Configure its HTTPS destination as `/supporters/webhooks/patreon` on the backend. Subscribe to the supported `members:*` and `members:pledge:*` create, update and delete events.
3. Configure `PATREON_CAMPAIGN_ID` and the webhook's `PATREON_WEBHOOK_SECRET`. Use a dedicated secret, separate from RCON, combat feed and session secrets.
4. Set `PATREON_FOUNDER_START_AT=2026-09-30T00:00:00-04:00` and `PATREON_FOUNDER_END_AT=2026-10-15T00:00:00-04:00`. Enable `PATREON_ENABLED` only after the database, HTTPS route and webhook are ready.
5. Confirm a real signed test delivery appears in the private Supporters page before relying on incoming records. Existing supporters are not automatically backfilled; review their provider records separately.

The backend uses Nest's original raw request body and verifies Patreon's HMAC-MD5 signature in constant time before parsing. It rejects bodies above 64 KiB and campaigns other than the configured one. These are Patreon's documented signature rules; v1 pledge hooks retire on October 7, 2026. Use the [official Patreon v2 webhook documentation](https://docs.patreon.com/#apiv2-webhook-endpoints).

## Reliability and privacy

Patreon's signature covers the body, not the event header. A durable body digest deduplicates retries independently of that header. Observation insertion and member updates are one transaction; staff actions have durable, actor-bound replay protection and record-version checks.

Webhooks do not establish a trustworthy delivery order. New observations always require review. Older charge dates cannot replace newer charge data, and undated updates preserve the last known charge date. Membership observations are not automatic entitlement decisions. A delayed first-seen payload can still represent old membership state; checking Patreon remains necessary.

Only administrators can read or edit this ledger. Mutations require the existing fresh role check, exact website origin and session CSRF token. The integration stores selected member/status fields and private payment references, not raw payloads, email addresses, postal addresses, card details or creator notes. Dashboard and proxy responses use no-store headers. The payment and audit ledger currently has no automatic purge; include it in the deployment's access, backup and retention decisions.

Local tests cover signatures, tampering, campaign checks, privacy, role/CSRF enforcement, replay, ordering and founder eligibility. Persistence tests inspect generated PostgreSQL queries and transaction behavior. Production migration execution and schema checks are complete; real Patreon delivery and authenticated staff use still need deployment verification.
