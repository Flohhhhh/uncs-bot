# Temporary web preview and authentication state

Updated October 5, 2026. This records the current implementation and the development setup still needed while the Next.js app is built.

## Current setup

The standalone Next.js app lives in `apps/web`. Nest still owns Discord OAuth, session storage, permissions and CSRF validation. The web app has no separate auth database or Better Auth installation.

There is a development database, and a independent API now exists in `apps/api`. Its credentials and database URL still need local configuration. The local preview is a simulated backend; it is not a development instance of the real authentication service.

The existing bot, backend and old dashboard still share the normal Nest application. A independent API startup is implemented separately in `apps/api`; see [its README](../../apps/api/README.md).

## What the preview is

`scripts/preview-admin.ts` starts a separate, local-only Nest process using the existing dashboard/API wiring with replacement services and simulated data. It does not start through the production `AppModule` and requires no Discord credentials, database or live game server. Its demo state stays in memory and resets when the process restarts.

Authentication has two modes:

| Mode                                         | Session behavior                                    | Purpose                                                       |
| -------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| Default, without `PREVIEW_AUTH_MODE=session` | Requests automatically receive demo staff identity. | Existing dashboard previews without signing in.               |
| `PREVIEW_AUTH_MODE=session`                  | Requests need a valid demo session cookie.          | Exercise the new web sign-in, reload, expiry and logout flow. |

In session mode, “Continue with Discord” calls the preview login endpoint, which creates a random HttpOnly, SameSite=Lax cookie and an in-memory session valid for eight hours. It redirects straight to `/admin`; it does not contact Discord or check real roles, MFA or membership. Logout validates the request origin and session CSRF token, invalidates the session and clears the cookie. Reads without a valid session return 401.

Both `http://localhost:3000` and `http://127.0.0.1:3000` are explicitly allowed for preview writes. CSRF checks remain enabled.

### Run the session preview

From the repository root, use separate terminals:

```bash
PREVIEW_PORT=4320 PREVIEW_AUTH_MODE=session npm run preview:admin
```

```bash
npm --prefix apps/web run dev
```

Open `http://127.0.0.1:3000/admin`. Use the same hostname throughout the session.

Next.js defaults to `http://127.0.0.1:4320` as its backend during development. A server-only `BACKEND_URL` in `apps/web/.env.local` overrides this; restart Next.js after changing it. The preview itself defaults to port 4317 when `PREVIEW_PORT` is omitted, so the explicit port above is intentional.

## Implemented web authentication

- `/sign-in` and `/access-denied` use the separate `(auth)` layout. The sign-in page checks the session on the server and renders the form directly when signed out.
- The server-only `readServerSession()` helper forwards the incoming HttpOnly cookie to `GET /admin/api/me`, validates the `id`, `name`, `role`, `csrf` and optional `demo` contract, and disables caching.
- The staff cookie uses `Path=/` so the server can check a session on both `/admin` and `/sign-in`; it remains host-only, HttpOnly and SameSite=Lax, and production uses Secure plus the `__Host-` prefix.
- The admin layout redirects `401` to sign-in and `403` to access denied before rendering protected content. Backend failures fail closed and offer a retry.
- There is no custom `SessionProvider`, client polling loop, or `AdminSessionGate`. Session data is passed from server components to the individual components that need it.
- The admin header shows display name, role, and the local-preview label when applicable. Its logout button sends one `POST /admin/api/logout` with the session's CSRF header. Uncertain failures require a manual retry and do not automatically repeat the POST.

The layout gate controls UI visibility. Nest remains the authorization boundary for every API request. Future server-side data fetching must verify authentication independently of the client layout.

## OAuth forwarding and real auth readiness

The web app has exact GET handlers for `/admin/auth/login` and `/admin/auth/callback`. They forward cookies and callback query parameters to Nest, use manual redirect handling, and preserve all upstream `Set-Cookie` headers, including cookie deletion on errors. Forwarding allows 45 seconds for Nest's successive Discord requests.

Successful Discord authorization redirects are preserved, and successful callbacks land on `/admin`. Callback 401 maps to an expired-sign-in message, 403 to access denied, and upstream failures to a sign-in-unavailable message. Browser-facing errors do not expose OAuth codes, tokens or upstream diagnostics. Existing `/admin/api/*` rewrites remain in place.

This supports the existing real Nest auth implementation. In that flow, Nest handles Discord identity, staff-role/MFA/membership checks, database-backed sessions, and origin/CSRF enforcement. Next.js forwards the resulting cookies to the browser and uses them for subsequent API requests.

### Configure a real development backend

Once a suitable development Nest instance is available:

1. Point its database configuration at the development database.
2. Configure its Discord OAuth credentials, including `ADMIN_DISCORD_CLIENT_ID` and `ADMIN_DISCORD_CLIENT_SECRET`. A separate development Discord OAuth application is recommended.
3. Set Nest's `ADMIN_ORIGIN` to the browser-facing Next.js origin, such as `http://localhost:3000`.
4. Register `http://localhost:3000/admin/auth/callback` in that Discord application's OAuth callbacks.
5. Set the web app's server-only `BACKEND_URL` to the development Nest address, then restart Next.js.

Keep localhost or 127.0.0.1 consistent between the browser, `ADMIN_ORIGIN` and registered callback. The backend address may differ from the browser-facing origin. Do not rewrite request origins to bypass Nest checks.

Using the real auth implementation does not require using the production backend. Connecting to production creates real production sessions; future write actions could affect live data or game servers.

## Development backend wrapper and remaining setup

Running the normal Nest startup locally also imports the Discord bot and scheduled/background modules. Pointing it at a development database alone does not isolate Discord or game-server integrations. Using production bot credentials locally could start another instance against the live Discord community.

The local `apps/api` API now contains a local copy of the admin module with a dedicated environment file and database connection. It excludes the gateway bot and background jobs, binds to the configured HTTP port, and allows reads and logout while blocking other writes. The root bot startup remains unchanged.

Set the development PostgreSQL URL and Discord auth settings in the ignored `apps/api/.env`, set web `BACKEND_URL=http://127.0.0.1:4321`, then run `npm run dev --workspace @uncs/api`. The development database must already have the required schema; no migrations are generated or applied by this startup. A live development database/OAuth flow still needs verification after configuration. See [backend setup](../../apps/api/README.md).

The development backend also supports `BACKEND_GAME_MODE=sample`, which replaces only game data with the shared preview fixtures. Real Discord auth, roles and database sessions remain active, and Next.js keeps using port 4321. The web status indicator labels this as **Sample game data**, separate from demo authentication. See [backend sample-mode setup](../../apps/api/README.md).

The standalone preview remains useful for UI work without credentials.

## Verification and boundaries

Verification from the initial auth implementation covered app-local auth/preview tests, simulated login and logout, protected navigation, access-denied and unavailable states, plus web/backend builds and repository checks. The current server-first auth structure is documented in [the auth overview](auth/overview.md); run the current app checks after changing this flow.

A real Discord OAuth login against a configured development backend has **not** been verified end to end. Mocked OAuth tests and demo login do not substitute for that check.

No production configuration, database migrations, root dependencies or deployment settings were changed for this increment. The old dashboard remains supported. Dashboard features and game actions have not been migrated into Next.js.

See [the web app README](../../apps/web/README.md) for standalone app commands and Railway configuration.
