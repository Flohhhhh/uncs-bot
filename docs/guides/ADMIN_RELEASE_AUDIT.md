# September 30 dashboard release audit

This is a source and isolated-preview audit. It does not certify the live game, production sign-in, payment intake or deployed website. The full game server was not used for test actions or read probes.

## Reviewed delivery boundaries

- Cleanup PR [#5](https://github.com/Flohhhhh/uncs-bot/pull/5) separates public applicant and staff origins, removes website hosting from Gramps, and tolerates individual malformed reserved-list rows. It does not repair xREALM's own interface.
- Dashboard PR [#6](https://github.com/Flohhhhh/uncs-bot/pull/6) replaces the old browser script with React/Vite in `web/admin`. Nest still owns authentication, permissions, CSRF, durable action receipts and RCON. One existing service serves the compiled UI; no new runtime or database migration is required.
- PR #6 is stacked on PR #5. Merge/review #5 first, then retarget #6 to `main`; do not merge #6 into its temporary feature-branch base. Railway deploys main automatically, so a merge is a production deployment decision.
- The public website remains in the separate `DappurD/uncs-website` repository on Cloudflare Pages. Its prepared origin-routing changes have not been confirmed deployed. The public page still showed Discord whitelist links during this audit.

## Confirmed defects addressed

- Action history fetched the live game snapshot unnecessarily. Its refresh now reads only stored history.
- Server controls could keep treating an old snapshot as current after time away. Tab visibility, records-page navigation and a 60-second freshness limit now invalidate it; a late response cannot undo an intervening invalidation.
- Stalled fetches or response bodies could hold the interface indefinitely. Reads now have a 45-second deadline and writes 60 seconds. Automatic refresh waits for pending reads instead of repeatedly cancelling them. Writes are never retried automatically.
- A late write response after a session change could be presented as definitely rejected. It now remains uncertain. Authentication-denial headers clear staff views immediately, without waiting for the body.
- A malformed successful session or overview response could crash the dashboard or enable controls. Required fields are validated before acceptance.
- Application/supporter reviews could freeze stale records while a replacement list was loading. Opening a review now waits for that refresh. Application details retain separate decision and original game-action receipt IDs.
- Map/lighting confirmation could use retained options after their refresh failed. Those controls now require a successful options load.
- A team batch could continue when its latest available roster showed the next player had left or changed team. It now stops for review. Skipped players no longer incur unnecessary spacing; the duplicate unload guard was removed.
- Action receipt IDs and staff reasons were absent from history search. Complete-ID lookup now retrieves older stored receipts through the existing staff guard and the same public-to-staff field selection; tests verify lookup beyond the latest 100 without any RCON request.
- Small-screen refresh had only a symbol as its accessible name. It now has a persistent label. Route changes update the page title and focus the heading.
- The existing fonts were losslessly packaged as WOFF2: 460,372 bytes became 167,708 bytes (64% less). Character mapping, glyph ordering and advance metrics were checked. Original license notices remain.
- Pull-request checks now run formatting and browser lint alongside backend tests, frontend tests and builds.

The companion website audit reproduced and fixed a visible stale applicant form after session expiry, submission racing sign-out, stalled fetch/body handling and late responses restoring a signed-out identity. It also discloses the public leaderboard's top-100/search limit. These changes require their own website review and publication; updating this bot does not deploy them.

Dependency audit still reports four moderate findings in the existing Drizzle/esbuild tooling chain (`drizzle-kit`, `@esbuild-kit/esm-loader`, `@esbuild-kit/core-utils`, nested `esbuild`), with no high or critical findings. They predate the React conversion. npm's proposed force-fix is a breaking downgrade of Drizzle Kit to 0.18.1, so it was not applied. Resolve through a separately reviewed, compatible database-tooling update; this audit did not regenerate or modify migrations.

## Launch work still requiring verified configuration

| Item | Current evidence | Remaining work |
| --- | --- | --- |
| Staff login | Floh's later Railway deployment was online with dashboard/OAuth/RCON variable names present. Last observed staff origin was the generated Railway hostname. | Reconcile with Floh; verify `ADMIN_ORIGIN=https://admin.theuncsgaming.com`, matching Discord callback, DNS/TLS and individual staff roles before switching users. Secret presence is not proof of a working login. |
| Website applications | Source routes and applicant cookies match Nest; the feature was enabled in Floh's later settings. | PR #5 requires `APPLICATION_ORIGIN=https://theuncsgaming.com` and its exact `/apply/auth/callback`. Publish Cloudflare routing/bindings and verify applicant login/submission with a designated test account. An absent origin deliberately fails closed. |
| Patreon tracking | Public $5 creator page and founder policy exist. Private ledger and signed-webhook handler are implemented. | Configure and verify a real signed Patreon delivery for the correct campaign. Review existing supporters separately; there is no historical backfill. Until verified, Patreon itself is the payment source of truth. |
| Founder promise | First successful payment of at least $5, September 30 through October 14 inclusive, Eastern time. Permanent promise is separate from subscription status. | Staff must verify completed payment evidence and account matching. Queue-tier activation depends on the future game update; nothing here grants a priority tier today. |
| Welcome/status/end-of-match messages | Optional Gramps worker exists; production activation and cutover are unverified. | Decide one owner for announcements, configure exact messages/status destination and disable overlapping automation during a planned cutover. Current round-transition detection is observational, not an authoritative end-of-match event. |
| Combat history / leaderboard | Pages and event-ingestion source exist; a reliable production event feed is not verified. | Confirm the official feed and choose compact aggregation/retention before activation. A full raw-event archive should not be enabled merely to populate a leaderboard. No automated cheating verdicts. |
| Seeding and queue benefits | Not implemented; queue tiers depend on game support. | Define verified playtime/seed criteria and independent entitlement sources before building automated grants or expiry. Current manual/free whitelist remains independent. |
| Private-data operations | Required emails, staff receipts and supporter evidence are stored server-side with role restrictions. | Confirm production backup/restore access and retention/deletion procedures with the database owner. This audit did not exercise a production restore or purge. |

## Release validation

Final local results: **307 backend tests, 107 dashboard tests and 42 companion website tests passed**. The full Nest/Vite production build, backend/frontend typechecks, global source formatting, scoped lint, website syntax and whitespace checks passed. All ten dashboard sections rendered with simulated data, no browser errors were observed, and a saved sample receipt was retrieved by exact ID without resending an action. At a narrow phone viewport the document stayed within its viewport, with wide tables scrolling inside their containers. The temporary viewport override was reset.

Use the pinned Node 22.23.3. Run `npm run format:check`, scoped lint, `npm run typecheck`, `npm run typecheck:admin`, `npm run test:frontend`, `npm run test:admin`, `npm run build` and `git diff --check`. The preview binds to loopback and replaces game, identity and database providers with samples. Browser checks must retain its visible local-preview banner.

Before merging, inspect the latest branch/base and CI results; do not overwrite concurrent changes from Floh. After approved deployment, verify static assets and login separately from gameplay actions. Any controlled game mutation needs a suitable test server or an explicitly agreed quiet test window. Reverting the frontend commit and rebuilding restores the preceding interface; this frontend release has no database rollback step.
