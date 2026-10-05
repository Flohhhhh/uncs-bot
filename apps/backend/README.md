# Development backend

A thin, local-only Nest startup wrapper around the existing admin module in `src/`. It uses root dependencies; it is not an independently installed package or a production deployment yet. It does not import the Discord gateway bot, command/event handlers, scheduler or background workers.

## Configuration

An ignored `apps/backend/.env` has been created from `.env.example`. Paste your **development database connection URL** into `DATABASE_URL`, then fill in the Discord credentials, guild and staff roles. Keep this file private. For a fresh checkout, copy `.env.example` to `.env` first.

Only this app's `.env` is loaded. The root `.env` and inherited shell variables are not used as fallback configuration. The process is restricted to development mode and listens on 127.0.0.1, port 4321 by default.

Nest still needs a Discord bot token for HTTP requests that verify membership and roles. It never logs that bot into the Discord gateway. Prefer a development Discord application with its bot installed in the guild you intend to use for staff checks. The OAuth application's callback must be `http://localhost:3000/admin/auth/callback`; `ADMIN_ORIGIN` must be `http://localhost:3000`. Use localhost consistently in the browser.

Generate a unique development session secret:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The database needs the existing schema, including staff session tables. This startup only checks connectivity; it never generates or applies migrations. Human contributors own database preparation and migrations.

## Run locally

Install root dependencies with `npm ci` using Node 22.23.3. No separate install inside this wrapper is required.

From the repository root, in separate terminals:

```bash
npm --prefix apps/backend run dev
npm --prefix apps/web run dev
```

Set this in `apps/web/.env.local` and restart Next.js:

```dotenv
BACKEND_URL=http://127.0.0.1:4321
```

Open `http://localhost:3000/admin`. This uses real Discord OAuth and database-backed sessions, not preview authentication.

## Current scope

The wrapper reuses `AdminModule`, its authentication, permission checks, API routes and security middleware. Reads and logout are allowed. Other write methods are blocked before shared handlers execute. In live mode, game endpoints are unconfigured by default, so game-dependent reads return unavailable until deliberate development targets exist. Game writes remain disabled in both modes.

### Sample game data with real auth

Set these in `apps/backend/.env`, then restart the backend:

```dotenv
BACKEND_GAME_MODE=sample
BACKEND_SAMPLE_SCENARIO=standard
```

Keep the web app pointed at port 4321. No separate preview process is needed. Real Discord OAuth, role checks and development database sessions remain active; only the game transport is replaced with in-memory fixtures shared with the preview.

Sample mode exposes Primary and Events servers through `GET /admin/api/servers`. Read players/status from `GET /admin/api/servers/primary/overview`; the response includes `players`. Bans, whitelist, settings, maps/catalog, rotation, activity and game logs also have sample data. Database-backed action history remains real development database data; no fake records are inserted into PostgreSQL.

Choose `standard` for six players, `full-server` for 100 players, or `pre-round` for the waiting-status scenario. Sample state resets on backend restart. The fixtures have no game network transport, disregard configured live game targets, and reject game mutations. The web status indicator shows **Sample game data** separately from real staff identity.

Set `BACKEND_GAME_MODE=live` to return to configured game targets. The example defaults to live for compatibility; the current local `.env` has been enabled for sample mode.

Other dashboard modules, such as applications and supporters, are not imported. Their APIs will need explicit integration as pages migrate. The shared module still owns the old dashboard page routes/assets; the supported UI for this wrapper is Next.js.

The database connection wiring is local to this app to avoid importing the shared database module's root environment loader. Schema, storage services, OAuth and business logic remain shared. Existing bot startup, root package dependencies and Railway commands are unchanged.

## Checks and build

```bash
npm --prefix apps/backend run check
npm --prefix apps/backend run build
npm --prefix apps/backend start
```

The build writes only to `apps/backend/dist` and includes the shared source files required by this startup. Tests mock the database and Discord responses; no real external calls are made.

Actual development database connectivity and Discord login require your completed local configuration and still need end-to-end verification.
