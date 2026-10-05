# Monorepo, web migration and service separation

Last reviewed: October 5, 2026.

## Objective and decisions

Gradually turn this repository into a monorepo with three independently built and deployed applications:

- **Web:** Next.js 16, React, shadcn, Tailwind and the UNCs theme, hosted on Vercel.
- **API:** NestJS, hosted as its own Railway service, owning authentication, authorization, game operations, persistence and business scheduling.
- **Bot:** NestJS/Necord, hosted as a separate Railway service in the same Railway project and environment, owning Discord interactions and delivery.

The goal is independent release and runtime lifecycles: a web change should not require restarting the bot; a bot restart should not interrupt dashboard requests or game automation.

Keep npm, Node 22.23.3, the current repository name and the existing development-to-main release workflow. Keep custom Discord authentication. Do not introduce Better Auth, a package-manager conversion, a CMS or a database replacement as part of this migration. Turborepo is optional after workspace adoption; npm workspace scripts are the initial default.

Preserve contributor workflows until their replacement is ready. Separate mechanical file moves from behavior changes, coordinate moves around active feature branches, and deliver small reviewable PRs. Continue local branch development without changing production services. A push can still trigger Railway depending on configured deployment branches and PR environments; a directory layout alone does not prevent deployment.

## Current state

| Area                 | Current implementation                                                                                                     | Status in this migration                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Backend/bot          | One Nest entry point importing HTTP, Discord and background modules                                                        | Existing production architecture; preserve initially                       |
| Existing dashboard   | React/Vite in `web/admin`, built and served by Nest                                                                        | Remains available until frontend cutover                                   |
| New web app          | Standalone npm app in `apps/web`, with its own lockfile                                                                    | Scaffold and tweakcn theme implemented                                     |
| Routing              | `(pages)` index redirects to `/admin`; `(admin)` and `(auth)` have separate layouts                                        | Implemented                                                                |
| Web tooling          | Root checks recognize web files; backend TypeScript excludes `apps/`                                                       | Implemented                                                                |
| New auth integration | API rewrites, exact OAuth forwarding routes, session provider/gate, sign-in/access-denied UI and simulated session preview | Present in the working tree; review and verify before treating as complete |
| Hosting              | Existing Railway service; Vercel/API/bot production separation not established by this work                                | Pending                                                                    |

The new app uses strict TypeScript, `~/` imports, T3 environment validation, next-themes, Sonner, nuqs, SWR, React Hook Form/Zod and TanStack Table. Its shadcn theme includes light/dark colors, chart/sidebar tokens, typography, shadows and radius.

The current backend has evolved beyond the initial dashboard: include map votes, server events, seeding/community state, telemetry, supporter matching, Patreon sync/linking, Discord role reconciliation, weekly leaderboards and staff alerts in the extraction inventory. Recheck this inventory before backend separation because contributors continue adding features.

This document is a roadmap, not evidence that existing production configuration, OAuth flows or live game actions have been verified.

## Target architecture and ownership

```text
Browser
  -> Next.js on Vercel
     -> HTTPS API entry point on Railway
        -> Game servers / PostgreSQL / external business integrations

Discord
  -> Bot on Railway
     -> Authenticated internal API over Railway private networking

API business jobs
  -> Persisted Discord delivery work
     -> Bot delivers messages / edits ballots / reconciles roles
```

Vercel is outside Railway's private network. The web server therefore needs an HTTPS-accessible API address. The bot can use the API's internal Railway address, but private networking does not replace service authentication.

| Concern                                                                         | Final owner                                                     |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Dashboard routes, forms, tables, navigation and presentation                    | Web                                                             |
| Browser-facing forwarding and session UX                                        | Web; API remains the authorization boundary                     |
| Discord OAuth exchange, staff/applicant sessions, CSRF and access policy        | API                                                             |
| Guild membership and role verification for API authorization                    | API through Discord REST, independent of bot gateway readiness  |
| Game credentials, RCON/HTTP connections, capability checks and server revisions | API                                                             |
| Game actions, applications, supporter records, telemetry and audit persistence  | API                                                             |
| Vote/event state, game scheduling, seeding policy and leaderboard calculation   | API                                                             |
| Patreon synchronization, account-link state and supporter matching              | API                                                             |
| Discord gateway, commands, listeners and interactive components                 | Bot                                                             |
| Discord notifications, ballot/status/leaderboard messages and role writes       | Bot                                                             |
| Welcome settings/state                                                          | API by the end of extraction; bot owns welcome-message delivery |
| Database migration deployment step                                              | API release path only after separation                          |

During extraction, an explicitly documented transitional direct database use is acceptable for bot-owned features that have not moved yet. It must have one writer/worker owner and an exit task. Shared database access is not the final boundary.

### Final repository shape

```text
apps/
  web/                Next.js application
  api/                Nest HTTP service and business workers
  bot/                Discord gateway application
packages/
  contracts/          Shared request/response schemas and types
  api-client/         Typed HTTP client with explicit error handling
  tooling/            Shared configuration only where useful
drizzle/              Existing human-owned migrations
```

Keep migrations at their existing `drizzle/` path; do not move them to achieve cosmetic layout consistency. Keep database implementation inside the API initially. Add packages only for actual sharing; apps must not import another app's implementation. Contracts must not import Nest, Discord clients, database stores, environment configuration or secrets.

## Authentication and API boundaries

### Browser sessions

Preserve the existing staff flow: Discord OAuth identifies the person; Nest checks 2FA, guild membership/screening and configured roles; an opaque HttpOnly cookie references a hashed database session with an eight-hour expiry. Preserve separate applicant sessions and their existing membership policy; applicant identity never grants staff authority.

Keep browser requests same-origin under the web app. Preserve `/admin/api/*` and `/admin/auth/login` / `/admin/auth/callback` during the frontend migration. Existing work uses Next rewrites for API calls and exact server route handlers for OAuth redirects. Keep that arrangement initially; introduce a more explicit API proxy only if forwarding requirements justify it.

- Nest's `ADMIN_ORIGIN` and Discord callback registration must match the browser-facing web origin, not the Railway backend origin.
- Forward session cookies and every `Set-Cookie` response correctly. Retain HttpOnly, Secure and host-only production cookie protections; do not loosen cookies to a parent domain.
- Preserve original request origin and CSRF headers for writes. Never rewrite an untrusted origin into an allowed one.
- Forward only configured backend paths. Avoid an arbitrary URL proxy and restrict OAuth redirect destinations.
- Keep identity/CSRF in memory. Do not add local-storage session tokens or expose service credentials through `NEXT_PUBLIC_` variables.
- Disable browser/CDN caching for private API/auth responses and verify the real Vercel-to-Railway headers. Adapt HTML security headers to Next's runtime rather than copying the old static-dashboard CSP blindly.
- Keep Nest permissions authoritative. Client layout gates and hidden buttons protect UX but cannot authorize data or actions. Future server-rendered private data also requires session verification.
- Missing backend configuration in production must fail visibly without falling back to a development or production target. The existing rewrite destination is resolved at build time; changing it requires a rebuild, and OAuth handlers also need the runtime variable.
- Preserve denial, expiry, malformed-response, offline and uncertain-logout handling. Login should not loop indefinitely during an upstream outage.

Sessions and permissions already belong to the backend. The web migration does not require issuing a second session or replacing auth libraries.

### Bot requests

Add a distinct internal API authentication mechanism when splitting processes. Use a scoped server-only bearer credential with support for overlap during rotation. The bot sends the Discord actor ID from the received interaction plus guild/server context; the API derives authorization rather than accepting a caller-supplied staff role.

Separate human actions from automated service operations. Human actions must pass action/server permission checks. System jobs have explicit limited permissions and are audited as system operations. A bot credential must not turn every command user into an administrator. Browser cookies must not authenticate internal service endpoints, and browser input must not be accepted as a trusted bot actor.

Keep existing game services as the execution layer behind both browser and bot entry points. Audit actor, caller, target server, action, correlation identifier and confirmed/failed/uncertain outcome. Do not log OAuth codes, session tokens or credentials.

### Contracts and uncertain writes

Preserve existing public endpoint shapes during the frontend port. Add browser-safe contracts from verified existing schemas/types when both clients need them; prefer additive changes over coordinated breaking deployments.

The API must remain compatible with the previous deployed web/bot version during rollout and rollback. For protocol changes, deploy additive backend support first, consumers second, and remove old support in a later release.

Do not automatically retry game mutations. Timeouts and broken connections can mean an action executed without a confirmed response. Show an uncertain result and direct staff to action history. A correlation ID is not an idempotency guarantee. Define any future deduplication mechanism separately before allowing mutation retries.

## Delivery phases

Each phase must retain a working deployment and has an explicit exit gate. Finish a phase's compatibility work before starting production cutover. The new web app can progress without immediately extracting the API or moving backend files.

### Phase 0 — Baseline and contributor protection

- [x] Create the standalone Next.js scaffold and apply the UNCs theme.
- [x] Keep root dependency ownership and the Railway build/start scripts unchanged during bootstrapping.
- [x] Add backend TypeScript exclusions and web-aware root tooling.
- [ ] Record current routes, feature flags, background jobs, integration providers and production health checks without copying secrets into documentation.
- [ ] Check configured Railway deployment branches/PR environments before pushing. Keep production unchanged while building locally.
- [ ] Inventory active contributor branches before any backend path moves.

**Exit gate:** both root and app-local clean installs/builds/checks pass; backend-only contributors do not need the web dependencies. Production receives no configuration changes from the local scaffold.

### Phase 1 — Backend connectivity and staff auth

- [ ] Review the auth integration already present in the working tree; retain other contributors' changes and distinguish mocked verification from real OAuth verification.
- [ ] Verify server-only backend configuration, API rewrites, exact OAuth handlers and cookie forwarding.
- [ ] Validate the simulated session preview with no Discord, database or live game access. Its opt-in session mode must not change the existing preview's automatic demo default.
- [ ] Verify sign-in, index redirect, session reload, focus/visibility rechecks, logout, expiry, permission loss and backend-unavailable UI.
- [ ] Verify real development Discord OAuth using a development bot/guild and personal development database. Check required staff 2FA and per-server access.
- [ ] Add app-specific CI for clean install, unit/component tests, lint, typecheck, formatting and production build; retain the existing backend/storage/frontend jobs.

**Exit gate:** local simulated auth works end to end and development OAuth has separate recorded evidence. No production credentials or real game actions are required for CI.

### Phase 2 — Admin shell and one read-only vertical slice

- [ ] Build the responsive shadcn navigation shell, staff account UI, server selector, loading/error states and keyboard-accessible mobile navigation.
- [ ] Port the existing overview behavior first. Keep server selection in the URL, validate API responses and cancel obsolete reads.
- [ ] Preserve the existing dashboard's refresh cadence, visibility behavior and snapshot-staleness rules unless a separately reviewed change intentionally alters them.
- [ ] Ensure switching server/session cannot display another server's late response or leave stale actions enabled.
- [ ] Keep all private responses uncached and prevent staff data rendering after an access denial.

**Exit gate:** browser -> Next -> simulated Nest API -> response is verified, including viewer/moderator/admin and restricted-server cases. No production UI is replaced yet.

### Phase 3 — Feature-by-feature dashboard migration

Port one feature per reviewable slice. Track feature parity and preserve existing permissions, validation and error semantics while changing presentation.

| Order | Feature group                                                               | Required parity                                                                      |
| ----- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1     | Overview, players, combat, history/audit, permissions and leaderboard views | Read-only accuracy, privacy, pagination/filter behavior and role visibility          |
| 2     | Applications, whitelist and supporters                                      | Private fields, review decisions, manual entry, Patreon status and matching behavior |
| 3     | Player actions, bans and announcements                                      | Role checks, confirmations, capability checks and uncertain outcomes                 |
| 4     | Match, maps, lighting, rotation and settings                                | Server revision checks, stale-snapshot rejection and unsaved-change protection       |
| 5     | Map votes, events, seeding/community and operational tools                  | Existing settings, scheduling semantics, Discord-linked state and recovery           |

- [ ] Reinventory pages immediately before each slice; features added by other developers also need a parity row.
- [ ] Port reusable response validation/client behavior before duplicating it across pages. Adapt tests to the new routes/components rather than preserving tests that assert obsolete markup.
- [ ] Preserve read/write timeouts, non-retried mutations, session revision handling, stale action authority and sequential bulk-action stop conditions from the existing client.
- [ ] Preserve accessibility, destructive confirmations, unsaved form handling and backend-generated audit records.
- [ ] Keep applicant/public website and Patreon link pages operational on their existing hosts. Their UI migration is outside the initial staff dashboard scope, but their backend URLs/callbacks must be accounted for during API extraction.

**Exit gate per feature:** meaningful component/API integration tests and simulated browser flows pass; the feature parity checklist has no unexplained omissions. Existing Vite dashboard remains usable during this phase.

### Phase 4 — Vercel staging and web cutover

- [ ] Create a Vercel project with `apps/web` as Root Directory, Node 22.x and app-local install/build commands.
- [ ] Establish a stable staging hostname for development OAuth. Arbitrary PR preview URLs use simulations or staging data; do not authorize arbitrary origins against production sessions.
- [ ] Configure staging backend URL at build/runtime and matching Discord callback/origin settings. Validate HTTPS cookies, forwarding, cache policy and rate limiting through the actual hosting chain.
- [ ] Review proxy timeouts against the current API's read/write behavior. Preserve uncertain results if the hosting layer times out before the backend completes a mutation.
- [ ] Confirm API aggregate peer limits do not unintentionally throttle all proxied web users; add trusted-edge controls without trusting arbitrary forwarding headers.
- [ ] Review Railway watch paths before merging so web-only changes do not restart the combined backend/bot. Include genuinely shared config/dependencies in affected builds.
- [ ] Choose a controlled release window, verify feature parity and switch the dashboard hostname/routing to Vercel.
- [ ] Keep the old dashboard build and a documented route back to it for the rollback window. Coordinate old/new auth origins explicitly; reauthentication may be required.

**Exit gate:** Vercel web runs independently against the current backend, with login/read/write/session tests verified in staging and a concrete routing/config rollback prepared. Any live production game verification requires separate authorization and an identified target.

### Phase 5 — Runtime separation before file relocation

- [ ] Add distinct API and bot bootstrap/module compositions while backend feature paths remain under `src/`.
- [ ] Add independent build/start/health commands. The API must boot without a Discord gateway connection; the bot must not import the full HTTP application or serve the dashboard.
- [ ] Split HTTP auth/business providers from legacy page/static asset serving so the API can import them without the old UI.
- [ ] Extract game/business calls behind authenticated internal endpoints and a typed bot client. Start with one read-only command, then one simulated human mutation.
- [ ] Create the Railway API service alongside the existing service, with environment-specific private networking, service credentials and independent readiness checks.
- [ ] Cut over scheduled work by capability. Disable the old owner before enabling the new one; do not start the existing `AppModule` in two services.
- [ ] Verify shutdown, reconnect behavior, API-unavailable bot responses and API availability during a bot restart.

**Exit gate:** API and bot run as independent processes with one owner for each worker, game state transition and Discord operation. The web points to the new API only after staging readiness is established.

### Phase 6 — Discord delivery and background-work extraction

Separate business state from Discord transport rather than moving whole feature modules wholesale:

- [ ] Map votes: API owns vote options, records, tally, lifecycle and winning game/event transitions; bot owns ballots/buttons/message edits and forwards authenticated actor events.
- [ ] Events/seeding/community: API owns plans, observations, reservations and execution; bot publishes status cards and announcements.
- [ ] Applications/supporters/Patreon: API owns decisions, matching, provider synchronization and link state; bot applies resulting roles and notifications.
- [ ] Weekly leaderboard: API computes the result and release schedule; bot posts/updates the Discord message.
- [ ] Staff alerts: API detects/persists incidents and acknowledgement state; bot sends/edits alerts and forwards staff interactions.
- [ ] Welcome and other commands: bot retains interaction behavior and centralized Discord logging, while durable business/settings operations move behind the API.

Use a persisted outbox for API -> bot delivery, implemented before moving any operation that currently relies on an injected Discord client. The API records business changes and delivery work together where transactional consistency is required. The bot claims work through authenticated internal endpoints with leases, bounded retry/backoff and acknowledgement. Bot-specific business writes return through API endpoints; the bot does not directly consume database tables.

Give deliveries stable identities and store Discord message identifiers so recovery can reconcile existing messages. A crash after Discord accepts a message but before acknowledgement must not be treated as proof that nothing happened. Do not promise exactly-once external delivery. Retry safe reconciliation separately from non-idempotent game mutations.

Schema needs must be planned as a separate integration step: agents may propose/update allowed application schema, but humans generate and review migrations. Do not add a message broker initially. Failed delivery should remain observable and recoverable without undoing confirmed game/business work.

**Exit gate:** bot disconnects do not block game API boot or lose pending delivery; reconnects and crashes do not duplicate business execution. Worker ownership and retry semantics have tests and operational documentation.

### Phase 7 — npm workspaces and final app directories

- [ ] Schedule mechanical moves around active branches. Announce exact paths/command changes and provide updated generator/typecheck/lint documentation.
- [ ] Convert the root package to a private npm workspace manifest for `apps/*` and `packages/*`, then consolidate lockfiles in one dedicated PR.
- [ ] Move the settled API and bot into their app directories without changing behavior in the same PR.
- [ ] Extract browser-safe contracts and the typed client; keep database/game implementation in the API.
- [ ] Preserve root convenience commands for the current contributor workflows, with explicit `dev:web`, `dev:api` and `dev:bot` commands. Avoid starting a second development bot implicitly.
- [ ] Update test roots, module registrations, generators, build paths, preview entry points and migration config references for the actual new paths.
- [ ] Update Railway builds to operate from the repository root with app-specific workspace commands so shared packages are available. Include dependent packages and root lockfile/tooling changes in watch paths.
- [ ] Update Vercel to resolve the shared workspace install while retaining `apps/web` as its application directory.
- [ ] Keep migrations at their committed path and make only the API release apply them. The bot release must not run the same migration step.

**Exit gate:** one clean root install builds/checks each app independently; shared contract changes validate every consumer; deploy configuration changes have been verified in staging before production updates.

### Phase 8 — Retire legacy serving and operational cleanup

- [ ] After the rollback window, remove Vite dashboard/static serving and its backend build coupling in a dedicated PR.
- [ ] Retain any public applicant/link routes until their replacements are explicitly planned and verified.
- [ ] Remove transitional bot database access, old combined entry points and obsolete worker flags after confirming final ownership.
- [ ] Document per-service configuration, health checks, local startup, credential rotation, delivery recovery and rollback.
- [ ] Confirm a web-only release leaves Railway services untouched and a bot-only release leaves web/API available.
- [ ] Consider Turborepo only if workspace build orchestration/caching has become a concrete need. Consider a repository rename separately after integration checks and contributor coordination.

**Exit gate:** independent deployments are demonstrated, rollback instructions are current, and no legacy process silently owns a migrated feature.

## Testing, release and rollback requirements

### Verification matrix

| Area                   | Required scenarios                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Authentication         | Login/callback cookie forwarding, expiry, reload, logout, MFA denial, role removal, Discord outage and applicant/staff isolation |
| Server access          | Global roles, per-server restrictions, version mismatch and switching server while a request is pending                          |
| Web behavior           | Responsive navigation, theme modes, keyboard access, loading/offline/malformed responses, stale data and unsaved changes         |
| Mutations              | Forbidden requests, missing/invalid CSRF, wrong origin, failed action, uncertain timeout and late response from an old session   |
| Service authentication | Missing/invalid/rotated credential, forged actor context, forbidden human operation and limited system operation                 |
| Worker extraction      | Only one owner, shutdown/restart, lease recovery, pending delivery while bot offline and no duplicated game execution            |
| Hosting                | Real proxy cookies/headers, private cache prevention, OAuth hostname consistency, rate limits and timeout behavior               |
| Rollback               | Previous client with new API; routing rollback; transfer of worker ownership without dual execution                              |

Use existing simulated game/storage providers for normal development and browser tests. Keep real storage/concurrency tests against the configured test PostgreSQL service. Test the actual business effects, access boundaries and uncertain results rather than writing tests that merely mirror implementation details.

For each implementation PR, run global `npm run format:check`, lint and typecheck for touched files, appropriate app/backend tests/builds, and `git diff --check`. Run handler validation for command/event changes. Run app-local checks during standalone installation, and workspace equivalents after consolidation. Include the app-local Tailwind formatting check in web CI even when backend-only root formatting uses its fallback formatter.

Keep feature development on branches, integrate through `development`, and release `main` through the existing periodic development-to-main PR process. Do not deploy production automatically from this roadmap. Repository settings and actual Railway/Vercel configuration must be inspected before each hosting transition.

### Database ownership

Agents must not run `db:generate` / `drizzle-kit generate` or create, edit, rename or delete committed migration files. Humans generate and review one migration after combined schema work is ready. Agents must not push/migrate a database without an explicit request identifying the target development database. No initial frontend phase requires a schema migration.

For later outbox/storage changes, use additive schema changes compatible with the previous deployment. Avoid destructive migrations during a cutover; application rollback must not depend on automatically reversing database changes.

### Operational evidence and rollback

Record the current deployed revision/config per service and the last verified successful staging flow. Monitor independent API readiness, action failure/uncertain rates, auth denials/upstream outages, worker ownership, delivery backlog age and bot connection health. Use sanitized correlation IDs across web/API/bot; keep sensitive application details and credentials out of logs.

Rollback a web release by restoring its previous deployment/routing and compatible auth-origin settings. Roll back API/bot releases against compatible contracts and additive database state. When transferring jobs back, stop the new owner and confirm its lease/shutdown state before enabling the previous owner. Never run old and new workers concurrently merely to preserve availability.

Before retiring the old dashboard or combined service, record the fallback deployment, required environment changes and recovery procedure. A rollback may require staff to sign in again when hostname/session context changes; document that explicitly.

## Immediate next implementation slice

Review and finish the existing local backend/auth work, add independent web CI, then migrate overview as the first real admin page. Keep production configuration and backend source paths unchanged during that slice. The next substantial backend milestone is separate process composition, not a wholesale directory move.

## References

- [Web development and current auth integration](../../apps/web/README.md)
- [Existing dashboard behavior](../../web/admin/README.md)
- [Staff dashboard delivery guide](../guides/ADMIN_DASHBOARD.md)
- [Release audit](../guides/ADMIN_RELEASE_AUDIT.md)
- [Repository contributor instructions](../../AGENTS.md)
- [Railway monorepo deployment](https://docs.railway.com/deployments/monorepo)
- [Railway private networking](https://docs.railway.com/networking/private-networking)
- [Vercel monorepo deployment](https://vercel.com/docs/monorepos)
