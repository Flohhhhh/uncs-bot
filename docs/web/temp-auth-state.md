# Temporary web preview and authentication state

Updated October 5, 2026. This records the current implementation and the development setup still needed while the Next.js app is built.

## Current setup

The standalone Next.js app lives in `apps/web`. Nest still owns Discord OAuth, session storage, permissions and CSRF validation. The web app has no separate auth database or Better Auth installation.

There is a development database, but no separately running development backend yet. The local preview is a simulated backend; it is not a development instance of the real authentication service.

The existing bot, backend and old dashboard still share the normal Nest application. A backend-only startup command has been proposed, but has **not been implemented**.

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

- `/sign-in` and `/access-denied` use the separate `(auth)` layout.
- A shared session provider validates `GET /admin/api/me` with Zod. The contract is `id`, `name`, `role`, `csrf` and optional `demo`.
- Identity and CSRF stay in memory. Session credentials use the backend's HttpOnly cookies and are never placed in local storage.
- Sessions are checked on initial load, every 30 seconds while authenticated and visible, and on focus. Requests time out after ten seconds; stale responses are ignored.
- The admin layout shows a loading skeleton while checking. A 401 clears staff data and redirects to sign-in; a 403 clears it and redirects to access denied. Connection errors or malformed responses hide protected content and offer retry.
- The admin header shows display name, role, the local-preview label when applicable, and logout. The status indicator derives from this provider rather than running another polling loop.
- Logout hides protected content and sends one `POST /admin/api/logout` with the session's CSRF header and same-origin credentials. Success or an already expired session returns to sign-in. Uncertain failures require manual retry and do not automatically repeat the POST.

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

## Development backend gap and recommended next step

Running the normal Nest startup locally also imports the Discord bot and scheduled/background modules. Pointing it at a development database alone does not isolate Discord or game-server integrations. Using production bot credentials locally could start another instance against the live Discord community.

The recommended next increment is a local backend-only startup command that uses real Nest OAuth, session storage and admin API with the development database, while excluding the Discord gateway bot and background jobs. Its outbound integrations and game-action targets also need deliberate development configuration. This entry point does not exist yet.

The preview remains useful for UI work without credentials while that setup is established.

## Verification and boundaries

Completed verification:

- 35 app-local unit tests under `apps/web/tests/unit/auth` and `apps/web/tests/unit/preview`, covering sessions, UI gating, logout, CSRF forwarding, mocked OAuth responses, and preview identity behavior.
- Simulated browser login, admin reload, logout and direct-navigation protection.
- Simulated access-denied and backend-unavailable browser states.
- Web and backend builds, touched-file lint/typecheck, global formatting and whitespace checks.

A real Discord OAuth login against a configured development backend has **not** been verified end to end. Mocked OAuth tests and demo login do not substitute for that check.

No production configuration, database migrations, root dependencies or deployment settings were changed for this increment. The old dashboard remains supported. Dashboard features and game actions have not been migrated into Next.js.

See [the web app README](../../apps/web/README.md) for standalone app commands and future Vercel configuration.
