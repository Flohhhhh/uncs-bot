# Website whitelist applications

The main website's `/whitelist` page lets a Discord member request access and check their own request. Gramps stores the application and provides an admin-only review queue. This is the existing free whitelist application process; it does not activate donations, queue tiers, seeding rewards, or paid benefits.

The feature is **disabled by default in code and enabled on production**. The website worker, Discord identity sign-in, selected-server return and joining instructions are deployed and read-verified. October 2 read-only inspection matched one genuine saved application and applied staff approval to the same active, saved game whitelist entry. The applicant's own returned status screen and actual queue experience remain unobserved. The [release audit](ADMIN_RELEASE_AUDIT.md) records deployment and acceptance evidence. No whitelist access was changed by release checks.

## Information collected

Discord sign-in supplies the account ID and display name. The bot checks membership in the configured Discord server; applicants do not need a staff role or Discord two-factor authentication. Staff reviewers still use the separate staff sign-in and its role/MFA requirements.

Applicants enter a SteamID64, email, and relationship (`unc_member`, `friend_regular`, or `new_player`), and acknowledge the community rules. Email is required by default. Consent covers contact about this application and server access, not a newsletter. **Email delivery and email ownership verification are not implemented.** The SteamID is a claim, not verified Steam ownership. Relationship is self-reported: it never proves UNC membership or approves access by itself. When [automatic Discord roles](DISCORD_ROLES.md) are switched on, a staff-approved `unc_member` application adds the UNC role; `friend_regular` and `new_player` never receive it automatically.

The database keeps the submitted values, consent version and time, rules acknowledgment, status, submission/update times, and private staff review records. Discord IDs and SteamIDs each have a unique constraint per game server, allowing the same member to apply separately to different configured servers. Duplicate errors do not reveal another applicant's information. There is no self-service correction or deletion endpoint yet; contact staff for corrections. Application records currently have no automatic retention/deletion job.

## Routes and access

The website serves the page; Gramps serves these routes through the same website origin:

| Route                                      | Behavior                                                                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /apply/auth/login`                    | Starts Discord sign-in with only the `identify` scope.                                                                                          |
| `GET /apply/auth/callback`                 | Completes sign-in and redirects to `/whitelist`.                                                                                                |
| `POST /apply/auth/logout`                  | Clears the applicant cookie after session, Origin, and CSRF validation.                                                                         |
| `GET /apply/api/me`                        | Returns `{userId, displayName, csrf, emailRequired, application}` for the signed-in account only.                                               |
| `POST /apply/api/request`                  | Accepts `{steamId, email, relationship, contactConsent: true, rulesAccepted: true}` and returns `{application}`.                                |
| `GET /admin/api/applications`              | Admin-only private review list: `{enabled, applications}`; `enabled: false` while the feature is off. Unresolved rows include `whitelistState`. |
| `POST /admin/api/applications/:id/approve` | Reviews a pending application and requests its stored SteamID be added.                                                                         |
| `POST /admin/api/applications/:id/decline` | Declines a pending application without contacting the game.                                                                                     |
| `POST /admin/api/applications/:id/recheck` | Rechecks a `processing` or `needs_review` application's running whitelist membership without changing the game.                                 |
| `POST /admin/api/applications/:id/revoke`  | Removes an approved application's SteamID from the whitelist and marks it `revoked`.                                                            |

Staff decisions accept `{id: <new review UUID>, reason: <3–200 characters>}` and return `{application, outcome: {id, state, message}}`. Approval also accepts `existingAccessConfirmed: true` (see below). The URL ID identifies the application; the body ID identifies that review attempt. The private list includes email and review notes; moderator/viewer roles cannot read it. It returns at most 100 records: unresolved requests first, oldest first, followed by recent resolved records. Counts describe this returned batch, not the entire database. Refresh after processing a batch to advance the queue.

The dashboard uses the server-scoped staff routes under `/admin/api/servers/:serverId/applications`; the table also lists legacy paths. Applicant login and `GET /apply/api/me` accept a `server` query parameter, and submissions carry `serverId`. Profile responses include the selected `serverId`, configured public server names and optional joining codes. Each server has its own application and grant. The signed login flow preserves the selected server; joining instructions must follow it rather than redirecting another server's applicant to primary.

Applicants can read only their own application, without private staff notes, reviewer identity, or internal action history. There is no public lookup by application ID, Discord ID, or SteamID.

## Approval and uncertain outcomes

Approval atomically changes `pending` to `processing` and writes a durable review record before sending the existing audited `whitelist-add` action. Concurrent requests cannot both claim the same pending application. The game action uses the stored SteamID and a fixed application-reference reason; private human review notes are not copied into the wider dashboard action history.

Only an `applied` result, confirmed by the running whitelist, marks the application `approved`. Pending, failed, or unknown results become `needs_review`; they do not silently retry. A repeated identical review ID returns its recorded result without issuing the action again. A new approval cannot be submitted for a processing or already reviewed application.

For `processing` or `needs_review`, **Recheck live whitelist** reads fresh running membership. An active matching entry changes the application to `approved`; an absent entry or unavailable read leaves it needing review. Saved configuration alone does not confirm active membership. Recheck preserves the original action ID and records its own review ID, actor, reason, and outcome. It never resends the whitelist change.

A crash or database completion failure can leave `processing`. Staff can recover with the same read-only recheck instead of editing the database or granting access again. A recheck does not create another processing claim: its result and receipt save together only if the inspected review and status still match. Concurrent checks or an intervening approval cannot overwrite each other's decisions. If the original approval finishes after a recheck, its original receipt is retained without replacing the newer status. Failed saves remain recoverable by another read; absent access during an in-flight approval remains unconfirmed until a later check. There is no automatic retry or reset.

Declining an application never removes an existing whitelist entry. Existing manual whitelist membership remains unchanged by merely submitting or declining a request.

## Statuses

`pending` → `processing` → `approved` or `needs_review`; `declined`; and, for revocation, `revoking` → `revoked`. Applicants see `revoking` as `processing` and see `revoked` as their status; the website needs its own copy for `revoked`. Each application also records `accessIntent` (`grant` or `revoke`, which a recheck uses), `whitelistGrant` (`granted` for a real grant, `existing` for a registered existing entry, or null when not recorded) and `revokedAt`. The applicant view never includes these fields or any whitelist membership.

For `pending`, `processing` and `needs_review` rows the staff list adds `whitelistState`: `active` (on the running whitelist), `saved` (saved but not live), `absent`, or `unknown` when the whitelist could not be read (the list still loads). It uses the dashboard's 10-second whitelist cache. Resolved rows have `null`.

## Existing whitelist members

People who are already whitelisted can submit a request too, so staff can match their Discord account to their game access. Submitting never changes access and never triggers an approval.

When staff approve a `pending` request, Gramps first reads the running whitelist. If the SteamID is already active and the approval carries `existingAccessConfirmed: true` (staff confirmed this Discord member owns it), the application becomes `approved` with `whitelistGrant: "existing"` and the message "Registered an existing whitelist entry; it was already active. No whitelist change was sent." No game action is sent and no `admin_actions` row is written; the application review record is the audit.

Without that confirmation, what happens depends on `WHITELIST_APPLICATION_EXISTING_CONFIRMATION_REQUIRED`:

- `false` (the default): the approval uses the normal grant, as before this check existed. An approval that applies records `whitelistGrant: null`, because the entry was already live and the grant changed nothing. The current dashboard sends only `{id, reason}`, so this keeps approvals of existing members working.
- `true`: the approval is refused with 409 and nothing is claimed: "This SteamID is already on the running whitelist. Confirm this Discord member owns it, then approve again to record the registration. No whitelist change will be sent." Turn this on only once the dashboard shows the confirmation step and sends `existingAccessConfirmed: true`; otherwise those approvals stay stuck at `pending`.

If the SteamID is not active, approval uses the normal grant and records `whitelistGrant: "granted"` when it applies, unless the SteamID is already in the saved configuration (saved but not running yet): that grant may have added nothing, so it records `whitelistGrant: null`. If the whitelist cannot be read, approval also uses the normal grant but records `whitelistGrant: null`: Gramps cannot tell whether the SteamID was already live, and a build that edits the saved configuration reports an existing entry as applied. A recheck that confirms access also leaves `whitelistGrant` unset, because the recheck does not know what the whitelist held before the approval. With [automatic Discord roles](DISCORD_ROLES.md) switched on, an approved `unc_member` application receives the UNC role either way, so ownership is only checked by staff when the confirmation is required.

## Approvals and supporter matching

With `SUPPORTER_AUTO_STEAM_FILL_ENABLED` on, an approval that recorded `whitelistGrant` `granted` or `existing` can fill the SteamID of the campaign's Patreon supporter record for the same Discord account, when that record has none (see [Automatic matching](PATREON_SUPPORTERS.md#the-steamid-fill)). An approval with no recorded grant never fills one; staff see its SteamID on the Supporters page to check. Matching runs after the review is saved and never delays or changes the review response. A later revocation keeps a copied SteamID and flags it for staff. The copied SteamID is still the applicant's claim; Steam ownership is not verified.

## Revoking access

`POST …/applications/:id/revoke` with `{id, reason}` (administrators only) claims an `approved` application, or a `needs_review` one whose earlier revocation was uncertain, as `revoking` and saves its review record before contacting the game. It then sends the audited `whitelist-remove` action with a fixed reason, "Website whitelist application <id> revoked."

- An applied or saved removal makes the application `revoked`.
- If the game refuses, Gramps reads the running whitelist before deciding (it sends nothing more). If the SteamID is still active, the application returns to `approved`: "The game refused the revocation; access unchanged." If it is no longer active (for example the game answers 404 `reserved_not_found` because the entry was already removed), the revocation is recorded and the application becomes `revoked`. If the whitelist cannot be read, the application stays `needs_review` for a recheck.
- An unknown result leaves it `needs_review`. **Recheck live whitelist** then marks it `revoked` when the entry is no longer live, or keeps it for review ("Still active; revoke again or check the host panel"). Staff can also revoke again. A `revoking` application left by a crash can be rechecked the same way.

Removing a SteamID on the **Whitelist** page also revokes the `approved` application for that SteamID on that server, with a review record naming the staff member and the action ("Removed from the Whitelist page (action <id>)."). Applications already being revoked are left alone. With automatic Discord roles switched on, a revocation removes the UNC role only if Gramps added it and no other approved UNC application remains; see [Discord roles](DISCORD_ROLES.md).

Reinstating a revoked application is not available yet. A declined or revoked application still blocks a new request for the same Discord account or SteamID on that server.

## Deployment prerequisites

1. For a new deployment, keep `WHITELIST_APPLICATIONS_ENABLED=false` until the remaining connection and end-to-end checks are complete. On the existing production service the owner has already enabled it; coordinate any change with the owner rather than assuming it is off. The application tables, `whitelist_applications` and `whitelist_application_reviews`, were applied and checked in the identified production database on September 30 under the owner's explicit launch authorization; see [Database prerequisite](ADMIN_DASHBOARD.md#database-prerequisite--launch-migration-applied). Other deployments still require the reviewed schema before activation.
2. Configure `APPLICATION_ORIGIN=https://theuncsgaming.com` and the shared Discord identity credentials: `ADMIN_DISCORD_CLIENT_ID`, `ADMIN_DISCORD_CLIENT_SECRET`, `ADMIN_SESSION_SECRET`, `ADMIN_GUILD_ID`, and `DISCORD_BOT_TOKEN`. These values remain server-side. Applicant login and submission do not require `ADMIN_ENABLED`, `ADMIN_ORIGIN`, or RCON credentials. Staff review still requires staff access, and granting game access requires the game connection.
3. Add the exact Discord OAuth redirect `https://theuncsgaming.com/apply/auth/callback`, alongside staff's `https://admin.theuncsgaming.com/admin/auth/callback`. `APPLICATION_ORIGIN` must match the public website origin exactly. Proxy `/apply/*` through that public origin, preserve host-only cookies/Origin, and prevent caching. The website's `/whitelist` route is the return page. Never share staff cookies with the public site.
4. Leave `WHITELIST_APPLICATION_EMAIL_REQUIRED=true` for the agreed required-email policy. The implementation supports `false` for a deliberate future policy change; any supplied email still requires contact consent. Leave `WHITELIST_APPLICATION_EXISTING_CONFIRMATION_REQUIRED=false` until the dashboard sends the existing-member confirmation (see [Existing whitelist members](#existing-whitelist-members)).
5. Configure client rate limits at the trusted website edge. Gramps also bounds requests by socket peer (30 auth or 180 API requests per minute; staff review routes use the dashboard's own limits in [Admin security](ADMIN_SECURITY.md), so applicant traffic cannot use them up) and submissions by authenticated account (5 per hour); these limits are per process and do not trust arbitrary forwarding headers.
6. Enable `WHITELIST_APPLICATIONS_ENABLED=true` in a development deployment and verify sign-in, own-record isolation, admin-only review, duplicate handling, and controlled game readback before production activation. When disabled, applicant routes and staff review actions return 503 and ask visitors to check back on the website. The staff list instead returns `enabled: false` with no records, without reading the application tables, and the dashboard's Applications page says applications are turned off. There is no Discord application fallback.

## Applicant session privacy

HTTPS uses distinct `__Host-uncs_applicant_oauth` and `__Host-uncs_applicant_session` cookies with Secure, HttpOnly, SameSite=Lax, and path `/`. OAuth state expires after five minutes. Applicant sessions last 30 minutes and contain signed, **not encrypted**, Discord identity, CSRF token, and timestamps; they contain no email or SteamID. No Discord access token is retained in the session.

Mutations require an exact Origin and `x-csrf-token`, and recheck Discord membership. Read-only requests may use the signed identity until expiry. Logout validates the session and request without requiring continued guild membership. Because these sessions are stateless, logout clears that browser's cookie but does not revoke a previously copied cookie before its expiry. Local development uses separate non-`__Host` cookie names scoped to `/apply`.

Application responses use no-store caching. Review access restrictions and cookie checks do not replace deployment access controls, database protection, or a defined contact-data retention policy.
