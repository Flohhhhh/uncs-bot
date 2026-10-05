# Backend monorepo transition state

Updated October 5, 2026. This describes the implemented development wrapper and the work remaining before web, backend and bot have independent deployments.

## Full goal

Run three applications with independent build, deployment and runtime lifecycles:

| Application                | Host                                            | Final responsibility                                                                       |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `apps/web`                 | Vercel                                          | Next.js UI, browser-facing forwarding, session UX and dashboard pages                      |
| `apps/backend`             | Railway, its own service                        | Nest HTTP API, authentication, permissions, game operations, persistence and business jobs |
| Bot, eventually `apps/bot` | Railway, a separate service in the same project | Discord gateway, commands, events, interactions and Discord delivery                       |

Both web and bot use the backend as the business/API boundary. A web release should not restart the bot, and a bot restart should not interrupt backend requests or business scheduling.

The broader [migration outline](../web/monorepo-web-separation-outline.md) calls the target API app `apps/api`. The implemented wrapper uses `apps/backend`; use that name for current commands. There is no need to rename it just to begin extracting services.

## What exists now

| Area                  | Current state                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production            | The existing combined Nest app still starts bot, HTTP routes and background modules together. Its entry point and Railway build/start commands are unchanged.                                     |
| New backend           | `apps/backend` is a local development startup wrapper, not the completed production backend extraction.                                                                                           |
| Shared implementation | The wrapper imports existing `AdminModule`, auth, storage, schema and game services from root `src/`. Those files have not been moved.                                                            |
| Process composition   | No gateway bot, command/listener modules, scheduler or background workers are imported by the wrapper.                                                                                            |
| Configuration         | Only `apps/backend/.env` is loaded. Root dotenv and inherited shell values are not fallback configuration. Development mode is enforced.                                                          |
| Network               | It binds to 127.0.0.1, port 4321 by default. It is not configured for Railway or public access.                                                                                                   |
| Database              | App-local pool/lifecycle wiring uses `pg`, Drizzle and the existing schema. It checks connectivity and closes its pool on shutdown.                                                               |
| Authentication        | Existing real Discord OAuth, database-backed staff sessions, role/MFA/membership checks, CSRF and permissions are reused.                                                                         |
| Writes                | HTTP reads and staff logout are allowed. Other write methods are blocked before shared handlers run. OAuth callbacks still create real staff sessions.                                            |
| Game connectivity     | Live mode requires explicitly configured development targets. Sample mode replaces game transport with shared in-memory fixtures while retaining real auth/database sessions.                     |
| API coverage          | Only the admin module is imported. Other feature APIs, such as applications and supporters, are not yet included.                                                                                 |
| Packaging             | The wrapper uses root dependencies and tooling. It has no independent dependency install/lockfile; npm workspaces have not been introduced.                                                       |
| Web                   | A standalone Next.js app has sign-in, access-denied, session gating, logout and an admin placeholder/status indicator, with a separate sample-game label. Dashboard pages have not been migrated. |
| Preview               | The isolated simulated Nest preview remains available, with automatic demo auth by default and an optional cookie-backed demo session mode.                                                       |

The wrapper's separate database wiring avoids importing the root database module's root environment loader. Business logic, schema and session storage behavior remain shared; the duplicate connection wiring is transitional.

The imported admin module still contains legacy dashboard page/static-asset serving. That does not mean this wrapper has a complete separately built legacy dashboard. Next.js is the supported UI for this development setup.

## Development configuration

The ignored `apps/backend/.env` is based on the committed `.env.example`. Fill in:

- `DATABASE_URL`: your development PostgreSQL database URL.
- Discord OAuth client ID/secret, guild ID and configured staff roles/owner IDs.
- `DISCORD_BOT_TOKEN`: used for Discord REST membership/role reads; no gateway connection is started.
- A unique `ADMIN_SESSION_SECRET` of at least 32 characters.
- `ADMIN_ORIGIN=http://localhost:3000`.

Register `http://localhost:3000/admin/auth/callback` in the Discord OAuth application. Prefer a development Discord application installed in the intended guild. Keep the browser hostname, configured origin and callback consistent; localhost and 127.0.0.1 are distinct browser origins.

Set this in `apps/web/.env.local`, then restart Next.js:

```dotenv
BACKEND_URL=http://127.0.0.1:4321
```

After installing root dependencies and the standalone web dependencies, run from the repository root in separate terminals:

```bash
npm --prefix apps/backend run dev
npm --prefix apps/web run dev
```

Open `http://localhost:3000/admin`. See [backend setup](../../apps/backend/README.md) and [web auth state](../web/temp-auth-state.md) for details.

### Neon compatibility

Neon's generated `@neondatabase/serverless` service is an alternative driver example, not a required integration step. This backend already uses `pg.Pool` and `drizzle-orm/node-postgres`. Neon supports node-postgres, so the existing adapter can use a Neon development database without installing the serverless driver or replacing storage services. See [Neon's official Node.js guide](https://github.com/neondatabase/website/blob/main/content/docs/guides/node.md).

Copy the development branch's full PostgreSQL connection URL into `DATABASE_URL`, preserving Neon's TLS connection parameters. Never place the database URL in browser-visible variables. Moving this backend to Railway does not by itself require a database driver change.

The development database must contain the required existing tables, including staff sessions. Startup does not create tables or generate/apply migrations. Human contributors own migration generation and review. Applying migrations or pushing a schema requires an explicit request identifying the target development database.

## Sample game mode

`BACKEND_GAME_MODE=sample` serves generated players, status, bans, whitelist/settings, catalogs, rotation, activity and game logs from the same port 4321 backend. Set `BACKEND_SAMPLE_SCENARIO` to `standard` (six players), `full-server` (100 players), or `pre-round` (waiting-status scenario), then restart the backend. The committed template defaults to `live`; the current local environment has sample mode enabled.

Both `primary` and `event` are available through the server-list API. Their game adapters share the extracted preview fixtures in `scripts/preview-game.ts` and never use a game network transport. Configured live game endpoints are ignored in sample mode.

Discord identity/permissions and PostgreSQL sessions remain real. `GET /admin/api/me` adds optional `gameMode` metadata, allowing the web provider to label sample data without claiming demo authentication or adding another request loop. Action history is still development database data, not seeded fake rows. All game writes stay blocked.

## Verification completed and still needed

Mocked backend integration tests verify:

- Dedicated environment values win over inherited production-looking shell values.
- The admin module starts without gateway/scheduled/background modules.
- Login uses existing Discord OAuth and the browser-facing callback.
- Session reads require a cookie and perform existing Discord role validation.
- Game writes are blocked.
- Logout retains origin/CSRF validation.
- Invalid configuration errors name fields without exposing supplied credentials.

Additional sample-mode tests verify server lists, 100-player rosters, game read routes, instance isolation, read-only transport and retention of real authentication. Tests make no real database, Discord or game-server calls. Backend wrapper build/typecheck/lint, the existing combined backend build, global formatting and whitespace checks passed. Earlier web tests and simulated browser checks cover preview sign-in/reload/logout and denial/unavailable UI.

Still needed after local configuration: real development database connectivity and full Discord OAuth verification, including session persistence, expiry, logout, role removal, MFA/membership rejection and per-server restrictions. Mocked success is not evidence that the live development setup is configured.

## Remaining transition work

### 1. Establish a reliable development baseline

Complete the local configuration and real auth verification above. Confirm the development database schema with the human migration owner. Inventory actual routes, feature flags, game integrations and background workers before extraction; contributors continue adding features.

Keep game credentials unconfigured until deliberate development targets exist. Introduce game writes only as an explicit next increment with permissions, CSRF, server-version checks, audit records and uncertain-outcome behavior preserved.

Add backend/web CI checks that exercise mocked integrations and builds without production credentials. Document normal startup, required installs and ports so other developers can use the new path without changing their existing bot workflow.

### 2. Port the web app incrementally

Build navigation and server selection, then migrate one read-only page end to end. Keep existing API contracts and the old dashboard available. Add other backend feature modules deliberately as their pages migrate, checking their transitive dependencies and startup side effects.

Port writes separately after development targets are established. Preserve backend authorization and mutation outcomes; do not automatically retry a game action when a timeout could mean it executed.

### 3. Make backend composition production-capable

The current startup is intentionally development-only. Before Railway deployment, add reviewed per-environment configuration that accepts deployment environment variables, binds appropriately, supports HTTPS browser origins and exposes readiness/liveness checks.

Define the complete API module inventory independently of the bot. Separate API/auth routes from old dashboard serving so the backend no longer needs the Vite dashboard build. Retain old serving until frontend parity and a rollback path are established.

Consolidate environment/database connection wiring when it can be shared without pulling bot startup or root dotenv into the backend. Keep one clear owner for connection pools and shutdown handling.

### 4. Separate the bot as an API consumer

Create a bot-specific startup/application module and eventually `apps/bot`. Replace direct calls to backend-owned business services and stores with a typed API client, one feature at a time.

Add internal service authentication distinct from browser sessions. The bot must pass the trusted Discord actor and guild/server context; the backend derives permissions rather than accepting a supplied role. Define limited system operations separately from human actions and support credential rotation.

Private Railway networking is transport isolation, not a substitute for service authorization. Browser cookies should not authorize bot-only service endpoints.

### 5. Assign business jobs and Discord delivery ownership

Move game/business scheduling into the backend while keeping Discord gateway/message/role delivery in the bot. Inventory map votes, server events, seeding/community logic, telemetry, supporter/Patreon operations, role reconciliation, leaderboards and staff alerts before deciding exact ownership.

Transfer each worker with one active owner, restart/recovery behavior and a rollback plan. Importing existing job modules unchanged may pull Discord clients back into the API or cause duplicate execution while the combined service remains running.

Implement durable delivery between backend and bot where business work depends on Discord messages or role updates. Plan an outbox/lease/acknowledgement mechanism with stable delivery identities and bounded retries; any schema changes require human-generated/reviewed migrations. Do not promise exactly-once external delivery or treat an uncertain game mutation as safe to retry.

### 6. Adopt independent packages and shared contracts

Coordinate mechanical path moves around active contributor branches. Move settled backend implementation into `apps/backend`, and bot implementation into `apps/bot`, without mixing those moves with behavior changes.

Introduce npm workspaces and consolidate dependency/lockfile ownership in a dedicated change. Keep root convenience commands for contributors. Extract browser-safe contracts and a typed API client only where real sharing exists; contracts must not import database clients, credentials, Nest runtime modules or Discord clients.

Remove cross-app implementation imports and transitional bot database access. Keep committed migrations at their current `drizzle/` path; only the backend release should eventually own migration deployment.

### 7. Stage and deploy independently

Create the Vercel web project and separate backend/bot Railway services in the same project/environment. Configure distinct build/start commands, environment ownership and watch paths so web-only changes do not restart Railway services.

Vercel needs an HTTPS-reachable backend; it cannot use Railway's private network. The bot can use the private backend address with service authentication. Register a stable staging browser origin/callback and verify cookies, CSRF, forwarding, proxy timeouts and rate limiting through the actual hosting chain.

Deploy additive API contracts before consumers, retain compatibility with previous client versions, and transfer worker ownership without running old/new owners concurrently. Keep the combined deployment and old dashboard as rollback options until replacements are verified.

## Completion criteria

The transition is complete when all three apps build and deploy independently, web and bot use authenticated backend boundaries, backend-owned state/jobs have one owner, Discord delivery recovers across bot downtime, and the old combined runtime/dashboard can be retired with a documented rollback path.

The local wrapper is the first process-composition step toward that goal. It is not evidence of production extraction, workspace adoption or live OAuth/database verification. No deployment or database migration is authorized by this document.
