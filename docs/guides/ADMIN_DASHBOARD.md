# The UNCs staff dashboard — powered by Gramps

Staff use [The UNCs dashboard](https://admin.theuncsgaming.com/admin). Players apply at [the public whitelist page](https://theuncsgaming.com/whitelist). These use separate staff and applicant sign-in routes; an applicant session does not grant dashboard access. Staff login, production routing and read-only game access are verified. On October 2, read-only inspection matched a genuine website application and applied staff approval to the same active, saved game whitelist entry. The applicant's own returned status screen and actual queue experience remain unobserved.

## Current delivery status

Checked October 2, 2026. The React dashboard is deployed. The [release audit](ADMIN_RELEASE_AUDIT.md) holds exact commits, test results, deployment receipts and historical checkpoints; use its newest section when checking what is live.

| Area                              | Current state and remaining acceptance                                                                                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Players, moderation and whitelist | Deployed with per-action review and recorded outcomes. Read-only production checks pass; controlled live mutations are not certified by those reads.                                                                          |
| Match & maps                      | Current map/layout, next-round queue, editable rotation, map/mode selectors and drag/keyboard reordering are deployed. Actual next-round adoption still needs a controlled check.                                             |
| Server settings                   | Fifteen documented scalar settings, a scoring slider with exact numeric input, saved-value timing and identity readouts are deployed. Host controls are identified separately.                                                |
| Server activity                   | Combines observed changes, action receipts and received native combat events. The feed receiver is configured but its first native batch remains unverified.                                                                  |
| Welcome messages                  | Two short, spaced messages are configured; naturally occurring joins produced accepted game receipts. In-game popup presentation and round-message delivery remain unverified.                                                |
| Voting and 50v50                  | Remain off. Automatic map voting is deployed; draft #69's saved map/mode/reminder controls need a human-owned migration and controlled acceptance. 50v50 also needs verified round timing.                                    |
| Public onboarding                 | A genuine application, applied staff approval and matching active/saved game grant are observed. Recent Discord welcomes lead to the updated website guide. Applicant return-screen and queue experience remain unobserved.   |
| Restart schedules                 | Host schedule “Restarts” is marked active for 23:00 UTC-4, but contains no tasks, reports no prior run and shows a stale next-run date. The separate daily-time field is blank, which preserves an unknown game-config value. |
| Multiple servers                  | Separate targeting, clients, permissions, receipts, feeds, applications and grants are implemented and tested with isolated servers. Only the primary game server is configured live.                                         |
| Analytics                         | GA4 page-view reception is observed. A genuine completed onboarding funnel has not been observed in analytics; staff application records remain authoritative.                                                                |

The QR banner is prepared and independently scan-tested but not applied to the game. Verified zone-layout images remain outstanding. No queue tiers, automatic seeding rewards, donation-to-access automation or Discord voice-based team assignment are enabled.

### What remains before calling the full rollout ready

1. **Floh or another human contributor: finish draft [#69](https://github.com/Flohhhhh/uncs-bot/pull/69)'s database change.** Generate and review the migration for `map_vote_policies` and nullable `map_votes.automation`; do not recreate the already-applied original voting tables. Run the disposable PostgreSQL suite and drift check, review the final diff, then use the normal development/release flow. Keep automatic voting, mode voting and both reminders off. The repository's migration-ownership rule is the reason this step is assigned to a human, not missing website-repository access.
2. **Owner and staff: arrange controlled voting/event acceptance.** Confirm Discord member voting and displayed totals, one vote per account, both optional reminders, tie/no-vote behavior, staff override and cancellation. Confirm a queued map, mode and layout actually load at the next normal match transition before enabling unattended voting. Exercise 50v50 warnings, balance and stop only in the agreed test setting. A saved queue or accepted command is not game-adoption evidence. Update the Discord voting instructions when the automatic flow is accepted; their current staff-run description is not the requested final experience.
3. **Owner: resolve the restart configuration.** Inspect the actual saved game restart time and choose the intended routine. The existing empty host schedule is not a verified after-match restart. Follow [host restart guidance](SERVER_COMMUNITY.md#host-restart-schedules), including timezone and daylight-saving behavior, before adding or changing any task. Do not use Restart as a test while players are active.
4. **Normal player activity: close the delivery gaps.** Observe the first native combat batch after a normal game start, the visible welcome popups and round notice, and an approved applicant returning to the site and joining the game. Observe a genuine analytics funnel without manufacturing applications or events. Accepted welcome receipts and a real approved whitelist grant already have evidence and do not need repeating as synthetic tests.
5. **Owner: apply and inspect the prepared banner.** The 1024×256 URL/QR asset is independently scan-tested at full size and two smaller sizes. It is not yet applied or confirmed visible in the game's server browser. Its URL and validation receipt are recorded in the release audit; change it only in an agreed configuration window.
6. **Finish the remaining evidence work.** Obtain current, verified images for the 11 catalogued zone layouts; do not draw guessed boundaries. The database owner should verify Neon retention and complete the [recovery checklist](ADMIN_SECURITY.md#database-recovery--owner-verification-required). Before adding another live server, validate its distinct connection, access, feed and whitelist with its actual configuration. East/Central traffic research and Discord friend-group team assignment remain documented research; no region move or voice-based team automation is authorized by those findings.

The main review concerns are the untested game transitions, the absent draft migration, incomplete native-feed evidence, and operational recovery. Automated tests verify the code under simulated or disposable conditions; they do not erase these acceptance gaps. The detailed [compatibility and research notes](WARDOGS_2026-09-30.md) separate supported game controls from host settings and proposals.

## Local preview and checks

```sh
npm ci
npm run preview:admin
# http://127.0.0.1:4317/admin

npm run test:admin
npm run test:frontend
npm run test:storage # requires the disposable PostgreSQL test database
npm run typecheck
npm run format:check
npm run lint -- src/admin src/database/schema.ts src/database/database.module.ts src/database/database.types.ts src/env/env.ts src/app.module.ts scripts/preview-admin.ts scripts/run-prettier.ts
npm run build
git diff --check
```

The preview uses the production HTTP controllers, action service, UI and RCON adapter, with a local fake transport, fake staff identity and in-memory audit storage. It binds to loopback only. It is a separate script, never imported into `AppModule` and never enabled through a production environment flag. It requires no bot token, database, OAuth secret or RCON credentials. Test fixtures use sample player data; preview actions only mutate that data. Restarting the preview resets it.

## Database prerequisite — launch migration applied

The dashboard core adds `admin_sessions` and `admin_actions` to `src/database/schema.ts`, with expiry/creation indexes. The combined launch migration, `drizzle/0002_uncs_admin_launch.sql`, adds 11 tables for administration, applications, combat history and supporters. It was applied to the identified production Neon database on September 30, 2026, through Railway's existing `npm run db:migrate` pre-deploy command.

Post-deployment read-only checks verified all 11 new tables and 116 columns, six validated foreign keys, 11 primary keys, four unique constraints, 14 explicitly defined indexes (four unique), the expected UUID default, and exact matches for all three recorded migration hashes. The existing welcome-settings row remained present and its content checksum was unchanged. After the Node 22.23.3 rebuild, the three migration hashes and welcome data were checked again and remained unchanged. These checks verify the schema and preserved welcome data, not the inactive integrations.

On September 30, 2026, the owner explicitly authorized the agent to generate, review and commit this launch migration, overriding the usual `AGENTS.md` rule: **"Human contributors own migration generation and commits."** After the production target was identified, the owner separately approved applying it and deploying with the new features off. These were explicit exceptions for this launch; the general rule remains unchanged for future work. Do not rerun migration generation for this applied release or point a local Gramps bot instance at the production bot or database.

The session table stores SHA-256 hashes of random 256-bit session tokens, a CSRF token, Discord identity and an eight-hour expiry. Expired sessions are cleaned up at login; logout deletes the session. The audit table records the action ID, staff identity, reason, target, validated request, timestamps and outcome. Its request ID is unique: retries cannot repeat an action. An initial durable record is required before contacting the game. A crash or lost response leaves an explicitly unknown result for staff to reconcile. Action history lists the latest 100 entries and supports exact action-ID lookup for older stored receipts. Lookup reads the stored outcome; it does not resend the action or confirm the current game state.

Existing `0003_lovely_caretaker.sql` contains the original voting/event tables; the production voting columns were read successfully on October 2. Do not generate another copy of those tables. Draft [#69](https://github.com/Flohhhhh/uncs-bot/pull/69) requires a distinct, human-generated migration for `map_vote_policies` and nullable `map_votes.automation`, followed by the disposable storage suite and migration-drift check. Keep voting and reminders off until controlled acceptance. See [voting release steps](SERVER_COMMUNITY.md#automatic-community-map-voting).

## Connection setup for a new deployment

1. Keep `ADMIN_ENABLED=false` until the reviewed migration and connection details are in place.
2. In the existing Gramps Discord application, add an exact OAuth redirect URI of `https://admin.theuncsgaming.com/admin/auth/callback`. The flow requires a Discord account with two-factor authentication enabled and requests only `identify`; Gramps's bot token verifies guild membership and assigned role IDs server-side.
3. Configure the variables documented in `.env.example` in the deployment's secret store. `ADMIN_ORIGIN` is an exact origin with no trailing slash or path. HTTPS is required outside local development. `ADMIN_SESSION_SECRET` must be a cryptographically random secret with at least 32 characters. RCON may use HTTP only over a suitably protected connection; its bearer password must not traverse an untrusted network unencrypted.
4. Set the guild and explicit staff IDs. No access is inferred from a role's name. Owners and configured admin roles receive all actions; moderator roles receive player moderation and announcements; viewers receive read-only access. A user must still belong to the configured Discord guild even if listed as an owner.
5. Configure the fixed RCON endpoint and password in the server environment. RCON destination is never accepted from browser input. Requests reject redirects, so credentials cannot follow a redirect to another host. Keep credentials out of page URLs and browser storage.
6. Enable the dashboard on a development deployment first. Verify Discord login, roles, read-only server status, and one controlled action against a development game server. Then arrange the production deployment and verify its actual capabilities.

All mutations require an exact Origin and a session-bound CSRF header. Membership is rechecked with Discord for every mutation; read-only role checks have a 30-second cache. The dashboard applies a same-origin content policy, frame restrictions, no-store caching and secure HttpOnly cookies. Unexpected errors are replaced with safe messages; raw config documents and upstream error bodies never go to staff browsers or logs.

## Giving staff access

Access is managed through Discord roles. Choose dedicated roles such as **UNC Server Admin**, **UNC Server Moderator**, and **UNC Server Viewer**, and map their exact Discord role IDs to `ADMIN_ADMIN_ROLE_IDS`, `ADMIN_MODERATOR_ROLE_IDS`, and `ADMIN_VIEWER_ROLE_IDS`. These are suggested names, not existing configured roles; names alone grant nothing. The roles do not need Discord's Administrator permission.

- **Admin:** all controls and private application records on an authorized game server. The community-wide admin role separately controls private supporter records.
- **Moderator:** kick, permanent ban/unban, private messages, forced respawn, team changes, and broadcasts.
- **Viewer:** general dashboard reads, without actions or private application/supporter records.

Assign a trusted person the mapped role in the configured Discord server, then send them `https://admin.theuncsgaming.com/admin`. They sign in with their own Discord account, must have completed server membership screening, and must have Discord two-factor authentication enabled. There is no shared website password or separate website account to create. Remove the mapped role to revoke that access: the next mutation checks membership again, while read access can remain cached for up to 30 seconds. A person who also has another permitted role or a configured owner ID retains that separate access.

## Selecting and adding game servers

The current game selector targets the selected server's clients, reads, actions, receipts, applications, feed and automation. Confirm the server name in each action review. An explicit registry requires an explicit server selection; it never silently sends a request to the legacy default. A changed connection version refuses an old review until the page is reloaded.

For another server, add its permanent ID, display name and separate RCON connection to `WARDOGS_SERVERS` in the deployment secret store, following `.env.example`. Preserve the existing server as `primary`; do not recycle an ID for a different server. Give each feed a distinct feed-only token and each Discord status card a distinct destination. Optional `staffRoles` may narrow community staff access but cannot elevate it; configured owners retain owner access. Present-but-empty role lists deny non-owners. Whitelist grants remain separate per server.

Each registry entry may also set `joinId` to that server's public WARDOGS **Join by ID** code. For the legacy single-server configuration, use `WARDOGS_SERVER_JOIN_ID` instead. Verify the code against **Server settings → Identity** before publishing it; never put an RCON password or endpoint in this field. Applicant profiles and public server discovery expose only the server ID, name and optional join code, without reading the game. Missing secondary-server codes stay unavailable instead of using the primary code. These optional metadata fields need no database migration and do not change action connection versions. The website joining card requires the corresponding website release.

Use one Gramps replica initially. Read caches and courtesy action limits are per process, while sessions, action deduplication and stored voting/event operations use the database. The community-message worker has no cross-process leader election; multiple replicas or overlapping third-party schedulers can duplicate messages.

## Live whitelist behavior

The UNCs owner reports adding whitelist entries through the current RCON console takes effect live. The dashboard therefore determines success from the **running list**, not an assumed restart requirement.

The whitelist view validates entries individually. A malformed entry no longer hides valid SteamIDs; the page shows the count requiring review in the server configuration. It never coerces numeric IDs (which can lose precision) or edits malformed entries automatically. A malformed response envelope still fails the read, and mutation input and post-write confirmation remain strict.

- Use live reserved-slot writes if the server advertises them in `/v1/capabilities`.
- Otherwise read the current config revision and modify only the requested `DefaultReservedPlayerIds` entry. Preserve the other entries, `MaxReservedSlots`, ban list, server feed and all unrelated configuration.
- Write with `If-Match`, never force overwrite or blindly retry a conflict.
- Read `/v1/reserved-slots` after the change. Report **applied** immediately when the running list confirms it. If saved but not reflected yet, report **pending**. If readback fails, report **unknown**.
- The whitelist page shows running membership and saved configuration separately. It does not interpret a failed request as an empty whitelist.

No automatic membership expiry or seeding reconciliation is included. A future entitlement model must keep existing/manual access, paid membership and seeding grants independent; expiring one source must not remove another valid source. The current growth whitelist policy is unchanged.

The optional [website application flow](WHITELIST_APPLICATIONS.md) collects required contact email and a self-reported community relationship after Discord sign-in. Its private Applications page is restricted to admins. Approval uses the same confirmed-live whitelist operation; uncertain outcomes have a read-only recheck rather than an automatic retry. It has a separate disabled-by-default feature flag and OAuth callback.

## Moving players between teams

The Live players page offers a destination beside each player, plus checkboxes for moving a selected group. Choose any faction advertised by the running game, review the names and destination, and confirm the move. Team moves do not require typing a SteamID; the selected player's exact ID is still validated by the server. Ban, removal and forced-respawn confirmations remain separate.

The roster reports faction codes (`RED`, `BLU`, `GRN`), while the team-change endpoint accepts the faction's current name. Resolve those codes through the official color palette and the running status response rather than assuming a faction name is always Blue. Read the roster after each change and distinguish a confirmed assignment from an accepted request awaiting observation. A confirmed assignment may still require the player to respawn. No forced kill is sent with a team move.

Group moves use the same authenticated and audited operation for each player, spaced to respect the dashboard's action limit. **Stop remaining moves** prevents unsent requests while an already-sent request finishes. Results remain separate per player; an error or uncertain result stops the rest for review. Unsent players remain selected for a new review after refreshing. This sequence runs in the open browser and is not resumed after closing it.

For an uncertain action, expand **Action details → Check saved result** in the review or team result. This reads its stored receipt without sending another game command. No receipt does not prove that the game did nothing. The same control is available after saving settings or a map selection; Action history still supports exact-ID lookup after the dialog is closed.

No built-in per-clan preferred-team or team-slot reservation setting was found in the September 30 public RCON client/configuration. The game's overpopulation lock is a separate general balance setting. Any future automatic UNC preference should use a verified Steam roster, allow a choice of destination, and respect the running game's restrictions. Display-name searches are only staff search aids; they do not establish membership or trigger automatic moves. No preference automation is active.

## Limits and operations

The optional admin-only [Patreon supporter ledger](PATREON_SUPPORTERS.md) records signed membership observations, staff-checked payment evidence, account matches and permanent founder promises. Availability and webhook delivery require separate verification; a membership observation does not verify payment or account ownership. Provider events never directly grant or remove game access.

Recorded player statistics, the public server leaderboard and staff combat history are described in [Combat history](COMBAT_HISTORY.md). The independently authenticated game-event feed is configured in production, but its first native batch is still unverified. Configuration alone does not make the history live.

The [Gramps community worker](SERVER_COMMUNITY.md) is configured for the approved welcome sequence and round notice. Announcements shows its loaded messages, spacing and process-local acknowledgments. It uses observed roster/round changes because authoritative join/end events are not documented; it does not announce a verified winner or promise results-screen timing. The separate Discord status card remains off. New installations default off and must avoid overlapping third-party announcements.

The browser refreshes every 20 seconds while visible, stops background requests when hidden or during a confirmation dialog, and shares short cached server observations across staff. The game does not currently provide a documented player-roster push event. RCON honors `Retry-After`; mutations are never blindly retried. Capabilities are refreshed every minute and after transport errors. Unknown routes are disabled.

Messages and reasons are conservatively limited to 200 characters. Bans are permanent until removed. A team change does not silently kill the player's character. **Queue next map** preserves the current match; match end/restart and map-change reviews explain their effects. “Change map” requests travel after the end-of-match screen; “Restart match” does not restart the host process. Settings display Now, Next match or Server restart from the game's supplied timing; a saved value alone does not prove live adoption.

Host process restarts, restart schedules, listener/security settings and feed destinations remain host-managed. The dashboard links the host's after-match restart instructions but does not operate that scheduler. No verified game-server description setting exists: the official console's description is local to that browser. Raw config editing and unsupported routes are not exposed.

Protocol references: [Wardogs API observations](https://github.com/warcon-app/warcon/blob/main/docs/wardogs-api.md), [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2). The connected game's capabilities and readback are authoritative.

See [Security review](ADMIN_SECURITY.md) and [WARDOGS compatibility](WARDOGS_2026-09-30.md) for the current implementation and deployment limits. The companion website checkout documents same-origin routing in its ADMIN-INTEGRATION.md.
