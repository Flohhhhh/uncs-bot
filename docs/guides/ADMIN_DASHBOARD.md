# The UNCs staff dashboard — powered by Gramps

The dashboard is intended for the main UNCs website's `/admin` path, with Gramps serving its protected pages and API through a same-origin Cloudflare proxy. The public Cloudflare Pages site currently shows a connection notice at `/admin`; the backend connection is not live. The local combined preview is `http://127.0.0.1:4318/admin`; Gramps also exposes `/admin` on its existing HTTP listener. It adds Discord staff sign-in, a live player roster, kicks, permanent bans/unbans, private messages, forced respawn, team changes, whitelist add/remove, broadcasts, map changes, lighting, end/restart match, a read-only rotation view, and a persistent action history.

## Current delivery status

Implemented and tested locally against simulated game responses. **Not connected to The UNCs production server, Discord OAuth application, or database yet.** The dashboard is disabled by default. The local preview is clearly labeled and cannot contact the live server.

The existing whitelist remains in place. There is no import, bulk replacement, expiry job, live billing connection, queue-tier emulation, bounty system, or tactical map. Welcome messages already configured in the third-party bot continue there. The Gramps community worker and private Patreon ledger are implemented locally but remain disabled and disconnected from production. Seeding rewards and automatic donation recognition are not active. See the integration details below before enabling these features.

## Local preview and checks

```sh
npm ci
npm run preview:admin
# http://127.0.0.1:4317/admin

npm run test:admin
npm run typecheck
npm run format:check
npm run lint -- src/admin src/database/schema.ts src/database/database.module.ts src/database/database.types.ts src/env/env.ts src/app.module.ts scripts/preview-admin.ts scripts/run-prettier.ts
npm run build
git diff --check
```

The preview uses the production HTTP controllers, action service, UI and RCON adapter, with a local fake transport, fake staff identity and in-memory audit storage. It binds to loopback only. It is a separate script, never imported into `AppModule` and never enabled through a production environment flag. It requires no bot token, database, OAuth secret or RCON credentials. Test fixtures use sample player data; preview actions only mutate that data. Restarting the preview resets it.

## Database prerequisite — launch migration prepared

The dashboard core adds `admin_sessions` and `admin_actions` to `src/database/schema.ts`, with expiry/creation indexes. The combined launch migration, `drizzle/0002_uncs_admin_launch.sql`, adds 11 tables for administration, applications, combat history and supporters. It leaves the existing welcome-settings table unchanged and has not been applied to a database.

On September 30, 2026, the owner explicitly authorized the agent to generate, review and commit this launch migration, overriding the usual `AGENTS.md` rule: **"Human contributors own migration generation and commits."** That exception does not authorize applying it to an unidentified database or changing the general rule for future work. Verify the actual database's migration journal, then test the reviewed migration on an explicitly selected development database before production. Do not point a local Gramps bot instance at the production bot or database.

The session table stores SHA-256 hashes of random 256-bit session tokens, a CSRF token, Discord identity and an eight-hour expiry. Expired sessions are cleaned up at login; logout deletes the session. The audit table records the action ID, staff identity, reason, target, validated request, timestamps and outcome. Its request ID is unique: retries cannot repeat an action. An initial durable record is required before contacting the game. A crash or lost response leaves an explicitly unknown result for staff to reconcile. Action history returns the last 100 entries; older records remain in the database.

## Connection setup

1. Keep `ADMIN_ENABLED=false` until the reviewed migration and connection details are in place.
2. In the existing Gramps Discord application, add an exact OAuth redirect URI of `https://<your-domain>/admin/auth/callback`. The flow requires a Discord account with two-factor authentication enabled and requests only `identify`; Gramps's bot token verifies guild membership and assigned role IDs server-side.
3. Configure the variables documented in `.env.example` in the deployment's secret store. `ADMIN_ORIGIN` is an exact origin with no trailing slash or path. HTTPS is required outside local development. `ADMIN_SESSION_SECRET` must be a cryptographically random secret with at least 32 characters. RCON may use HTTP only over a suitably protected connection; its bearer password must not traverse an untrusted network unencrypted.
4. Set the guild and explicit staff IDs. No access is inferred from a role's name. Owners and configured admin roles receive all actions; moderator roles receive player moderation and announcements; viewers receive read-only access. A user must still belong to the configured Discord guild even if listed as an owner.
5. Configure the fixed RCON endpoint and password in the server environment. RCON destination is never accepted from browser input. Requests reject redirects, so credentials cannot follow a redirect to another host. Keep credentials out of page URLs and browser storage.
6. Enable the dashboard on a development deployment first. Verify Discord login, roles, read-only server status, and one controlled action against a development game server. Then arrange the production deployment and verify its actual capabilities.

All mutations require an exact Origin and a session-bound CSRF header. Membership is rechecked with Discord for every mutation; read-only role checks have a 30-second cache. The dashboard applies a same-origin content policy, frame restrictions, no-store caching and secure HttpOnly cookies. Unexpected errors are replaced with safe messages; raw config documents and upstream error bodies never go to staff browsers or logs.

## Giving staff access

After the production connection is verified, access is managed through Discord roles. Choose dedicated roles such as **UNC Server Admin**, **UNC Server Moderator**, and **UNC Server Viewer**, and map their exact Discord role IDs to `ADMIN_ADMIN_ROLE_IDS`, `ADMIN_MODERATOR_ROLE_IDS`, and `ADMIN_VIEWER_ROLE_IDS`. These are suggested names, not existing configured roles; names alone grant nothing. The roles do not need Discord's Administrator permission.

- **Admin:** all game controls, plus private application and supporter records when those features are enabled.
- **Moderator:** kick, permanent ban/unban, private messages, forced respawn, team changes, and broadcasts.
- **Viewer:** general dashboard reads, without actions or private application/supporter records.

Assign a trusted person the mapped role in the configured Discord server, then send them the website's `/admin` address. They sign in with their own Discord account, must have completed server membership screening, and must have Discord two-factor authentication enabled. There is no shared website password or separate website account to create. Remove the mapped role to revoke that access: the next mutation checks membership again, while read access can remain cached for up to 30 seconds. A person who also has another permitted role or a configured owner ID retains that separate access.

## Live whitelist behavior

The UNCs owner reports adding whitelist entries through the current RCON console takes effect live. The dashboard therefore determines success from the **running list**, not an assumed restart requirement.

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

Group moves use the same authenticated and audited operation for each player, spaced to respect the dashboard's action limit. Results are shown individually; an error or uncertain result stops the remaining moves for review. This is a staff-operated sequence in the open browser, not an unattended background job. Refresh or closing the page does not resume a partially completed group.

No built-in per-clan preferred-team or team-slot reservation setting was found in the September 30 public RCON client/configuration. The game's overpopulation lock is a separate general balance setting. Any future automatic UNC preference should use a verified Steam roster, allow a choice of destination, and respect the running game's restrictions. Display-name searches are only staff search aids; they do not establish membership or trigger automatic moves. No preference automation is active.

## Limits and operations

The optional admin-only [Patreon supporter ledger](PATREON_SUPPORTERS.md) records signed membership observations, checked payment receipts, linked Discord/Steam accounts and permanent founder promises. Its approved campaign runs September 30 through October 14, 2026, Eastern time, for a $5/month supporter tier. Provider events never directly grant or remove game access. The creator webhook and production database are not connected yet.

Recorded player statistics, the public server leaderboard and staff combat history are described in [Combat history](COMBAT_HISTORY.md). They use an independently authenticated game-event feed; production feed settings have not been changed.

The optional [Gramps community worker](SERVER_COMMUNITY.md) adds game welcome messages, generic round-transition broadcasts and updates to one existing Discord status message. All switches default off. It uses observed roster/round changes because authoritative join/end events are not documented; it does not announce a verified winner or promise results-screen timing. Configure the literal messages and existing Discord message in deployment settings, then disable overlapping third-party announcements before activation. No production cutover has been performed.

The browser refreshes every 20 seconds while visible, stops background requests when hidden or during a confirmation dialog, and shares short cached server observations across staff. The game does not currently provide a documented player-roster push event. RCON honors `Retry-After`; mutations are never blindly retried. Capabilities are refreshed every minute and after transport errors. Unknown routes are disabled.

Messages and reasons are conservatively limited to 200 characters. Bans are permanent until removed. A team change does not silently kill the player's character. “Restart match” reloads the match, not the host process. Host restarts, host scheduling, raw configuration editing, rotation editing, and unsupported game routes remain outside this dashboard version.

The actions use a single configured game server. Use one Gramps replica initially; its short read cache and courtesy action throttle are per process, while sessions and request deduplication are database-backed. Do not let multiple tools manage an automatic welcome/announcement schedule at the same time when a later cutover is performed.

Protocol references: [Wardogs API observations](https://github.com/warcon-app/warcon/blob/main/docs/wardogs-api.md), [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2). The connected game's capabilities and readback are authoritative.

See [Security review](ADMIN_SECURITY.md) and [September 30 Wardogs compatibility](WARDOGS_2026-09-30.md) for the current implementation and deployment limits. The companion website checkout documents same-origin routing in its ADMIN-INTEGRATION.md.
