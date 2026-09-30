# Website whitelist applications

The main website's `/whitelist` page lets a Discord member request access and check their own request. Gramps stores the application and provides an admin-only review queue. This is the existing free whitelist application process; it does not activate donations, queue tiers, seeding rewards, or paid benefits.

The feature is implemented for local testing and **disabled by default**. No production database migration, OAuth connection, or live whitelist application has been performed as part of this implementation.

## Information collected

Discord sign-in supplies the account ID and display name. The bot checks membership in the configured Discord server; applicants do not need a staff role or Discord two-factor authentication. Staff reviewers still use the separate staff sign-in and its role/MFA requirements.

Applicants enter a SteamID64, email, and relationship (`unc_member`, `friend_regular`, or `new_player`), and acknowledge the community rules. Email is required by default. Consent covers contact about this application and server access, not a newsletter. **Email delivery and email ownership verification are not implemented.** The SteamID is a claim, not verified Steam ownership. Relationship is self-reported and never grants a Discord role, proves UNC membership, or automatically approves access.

The database keeps the submitted values, consent version and time, rules acknowledgment, status, submission/update times, and private staff review records. Discord IDs and SteamIDs each have a unique constraint, allowing one application per account/SteamID. Duplicate errors do not reveal another applicant's information. There is no self-service correction or deletion endpoint yet; contact staff for corrections. Application records currently have no automatic retention/deletion job.

## Routes and access

The website serves the page; Gramps serves these routes through the same website origin:

| Route                                      | Behavior                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `GET /apply/auth/login`                    | Starts Discord sign-in with only the `identify` scope.                                                           |
| `GET /apply/auth/callback`                 | Completes sign-in and redirects to `/whitelist`.                                                                 |
| `POST /apply/auth/logout`                  | Clears the applicant cookie after session, Origin, and CSRF validation.                                          |
| `GET /apply/api/me`                        | Returns `{userId, displayName, csrf, emailRequired, application}` for the signed-in account only.                |
| `POST /apply/api/request`                  | Accepts `{steamId, email, relationship, contactConsent: true, rulesAccepted: true}` and returns `{application}`. |
| `GET /admin/api/applications`              | Admin-only private review list: `{applications}`.                                                                |
| `POST /admin/api/applications/:id/approve` | Reviews a pending application and requests its stored SteamID be added.                                          |
| `POST /admin/api/applications/:id/decline` | Declines a pending application without contacting the game.                                                      |
| `POST /admin/api/applications/:id/recheck` | Rechecks a `needs_review` application's running whitelist membership without changing the game.                  |

Staff decisions accept `{id: <new review UUID>, reason: <3–200 characters>}` and return `{application, outcome: {id, state, message}}`. The URL ID identifies the application; the body ID identifies that review attempt. The private list includes email and review notes; moderator/viewer roles cannot read it. It returns at most 100 records: unresolved requests first, oldest first, followed by recent resolved records. Counts describe this returned batch, not the entire database. Refresh after processing a batch to advance the queue.

Applicants can read only their own application, without private staff notes, reviewer identity, or internal action history. There is no public lookup by application ID, Discord ID, or SteamID.

## Approval and uncertain outcomes

Approval atomically changes `pending` to `processing` and writes a durable review record before sending the existing audited `whitelist-add` action. Concurrent requests cannot both claim the same pending application. The game action uses the stored SteamID and a fixed application-reference reason; private human review notes are not copied into the wider dashboard action history.

Only an `applied` result, confirmed by the running whitelist, marks the application `approved`. Pending, failed, or unknown results become `needs_review`; they do not silently retry. A repeated identical review ID returns its recorded result without issuing the action again. A new approval cannot be submitted for a processing or already reviewed application.

For `needs_review`, **Recheck live whitelist** reads fresh running membership. An active matching entry changes the application to `approved`; an absent entry or unavailable read leaves it needing review. Saved configuration alone does not confirm active membership. Recheck preserves the original action ID and records its own review ID, actor, reason, and outcome. It never resends the whitelist change.

A crash or database completion failure can leave `processing`. This state deliberately has no automatic retry or reset. An operator must inspect the original action record and running whitelist, then reconcile the database record deliberately. Declining an application never removes an existing whitelist entry. Existing manual/free whitelist membership remains unchanged by merely submitting or declining a request.

## Deployment prerequisites

1. Keep `WHITELIST_APPLICATIONS_ENABLED=false` until the combined schema migration is verified and applied to the intended deployment. The new application tables are `whitelist_applications` and `whitelist_application_reviews`; they complement the dashboard tables. The launch migration is generated under the owner's explicit September 30 override of the usual human-only preparation rule, but has not been applied; see [Database prerequisite](ADMIN_DASHBOARD.md#database-prerequisite--launch-migration-prepared). Test it on an explicitly selected development database before enabling the feature.
2. Configure the existing [staff dashboard settings](ADMIN_DASHBOARD.md#connection-setup). Applicant authentication currently shares `AdminSettings`, so it also requires `ADMIN_ENABLED=true`, `ADMIN_ORIGIN`, `ADMIN_DISCORD_CLIENT_ID`, `ADMIN_DISCORD_CLIENT_SECRET`, `ADMIN_SESSION_SECRET`, `ADMIN_GUILD_ID`, `DISCORD_BOT_TOKEN`, and the configured `WARDOGS_RCON_URL`/`WARDOGS_RCON_PASSWORD`. These values remain server-side.
3. Add the exact Discord OAuth redirect `https://<your-domain>/apply/auth/callback`, alongside the existing staff callback. `ADMIN_ORIGIN` must match the public website origin exactly. Proxy `/apply/*` to Gramps through that origin, preserve cookies/Origin, and prevent caching. The website's `/whitelist` route is the return page.
4. Leave `WHITELIST_APPLICATION_EMAIL_REQUIRED=true` for the agreed required-email policy. The implementation supports `false` for a deliberate future policy change; any supplied email still requires contact consent.
5. Configure client rate limits at the trusted website edge. Gramps also bounds requests by socket peer (30 auth or 180 API requests per minute) and submissions by authenticated account (5 per hour); these limits are per process and do not trust arbitrary forwarding headers.
6. Enable `WHITELIST_APPLICATIONS_ENABLED=true` in a development deployment and verify sign-in, own-record isolation, admin-only review, duplicate handling, and controlled game readback before production activation. When disabled, application routes return 503 with the existing [Discord whitelisting fallback](https://discord.gg/t5NSzurtRS).

## Applicant session privacy

HTTPS uses distinct `__Host-uncs_applicant_oauth` and `__Host-uncs_applicant_session` cookies with Secure, HttpOnly, SameSite=Lax, and path `/`. OAuth state expires after five minutes. Applicant sessions last 30 minutes and contain signed, **not encrypted**, Discord identity, CSRF token, and timestamps; they contain no email or SteamID. No Discord access token is retained in the session.

Mutations require an exact Origin and `x-csrf-token`, and recheck Discord membership. Read-only requests may use the signed identity until expiry. Logout validates the session and request without requiring continued guild membership. Because these sessions are stateless, logout clears that browser's cookie but does not revoke a previously copied cookie before its expiry. Local development uses separate non-`__Host` cookie names scoped to `/apply`.

Application responses use no-store caching. Review access restrictions and cookie checks do not replace deployment access controls, database protection, or a defined contact-data retention policy.
