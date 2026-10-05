# Web authentication overview

The Next.js app does not own staff identity or sessions. Nest owns Discord OAuth, the staff session database, role checks, CSRF validation and authorization. The web app asks Nest to verify the browser's HttpOnly session cookie and uses that result to decide what to render.

This is a custom integration, not Better Auth. Better Auth is not installed in `apps/web`; no auth tables or second session store are created there.

## Request flow

1. The browser starts at `/admin/auth/login`. The Next.js route handler forwards the request to Nest, which creates a short-lived signed OAuth state cookie and redirects to Discord.
2. Discord returns to `/admin/auth/callback`. Next.js forwards the callback query and cookies to Nest and relays the redirect and every `Set-Cookie` header.
3. Nest validates the OAuth state, exchanges the code with Discord, checks the Discord account, and checks guild membership and configured staff roles. Accounts must have two-factor authentication enabled and complete membership screening.
4. Nest creates the database-backed staff session and redirects to `/admin`.
5. Next.js server code forwards the incoming browser cookie to `GET /admin/api/me`. A valid response includes staff `id`, `name`, `role` and the CSRF token used for mutations. The response is validated before the staff account is rendered.

The browser only talks to the web app's same-origin `/admin/api/*` paths. Next.js rewrites those API requests to the configured server-only `BACKEND_URL`. OAuth has dedicated Next.js route handlers because redirects and multiple `Set-Cookie` headers must be relayed to the browser.

## Next.js behavior

`readServerSession()` in `apps/web/src/lib/session/server.ts` is the server-only session helper. It forwards the incoming cookies to Nest, disables caching, applies a ten-second timeout and validates the response with the shared Zod schema. React request caching avoids repeating the check when server layouts and pages both need the same session during one render.

The `(admin)` layout redirects a `401` session to `/sign-in` and a `403` to `/access-denied`. A valid session renders the dashboard and passes only the staff fields needed by its components. If Nest is unavailable, the layout fails closed and renders a retry state instead of protected content.

The sign-in route also checks on the server. An already authenticated staff member goes to `/admin`; a signed-out visitor receives the sign-in form directly. There is no client-side session-checking screen, global `SessionProvider`, periodic polling loop or local-storage credential.

The staff account control is a small client component because logout is interactive. It sends one `POST /admin/api/logout` with the session CSRF token. If the outcome is uncertain, it asks the user to retry instead of silently repeating the request. Nest validates and revokes the session. Dashboard data/API routes must continue handling Nest authorization responses; hiding controls in Next.js is not an authorization boundary.

## Nest session and security checks

`AdminAuth` implements the custom staff session:

- The OAuth state cookie is random, signed with `ADMIN_SESSION_SECRET`, HttpOnly, SameSite=Lax and expires after five minutes.
- After Discord identity, MFA, guild membership, membership screening and role checks pass, Nest generates a random 32-byte session token. It stores only the SHA-256 hash in the `admin_sessions` database table. The record includes the Discord user ID, display name, CSRF token and eight-hour expiry.
- The browser cookie contains the opaque session token. It is HttpOnly, SameSite=Lax, host-only and Secure for HTTPS. Production uses the `__Host-` prefix. Its path is `/` so Next.js can read it on both `/admin` and `/sign-in`; path scoping is not used as an authorization control. Logout and successful sign-in also clear legacy local `/admin`-scoped cookies.
- `GET /admin/api/me` validates the cookie and expiry, looks up current Discord staff role information and returns the minimal staff session contract. Role results are briefly cached in Nest memory.
- Protected Nest API routes use `AdminGuard`. Every mutation also requires the request `Origin` to equal `ADMIN_ORIGIN` and `X-CSRF-Token` to match the session token. Comparisons use a timing-safe check. `GET` and `HEAD` do not require a CSRF header.
- Logout is a `POST`. Nest validates the same session, origin and CSRF conditions, deletes the session record and clears the session and OAuth cookies.

The Next.js layout check improves navigation and initial rendering. Nest remains authoritative and rechecks each protected API request, so direct API access cannot bypass the web layout.

## Local development

For the standalone simulated preview, run the Nest preview with `PREVIEW_AUTH_MODE=session`. It creates an in-memory demo session and does not contact Discord or the development database. For real Discord auth against a development database, run `apps/backend` with its development environment and point `apps/web/.env.local` at it using `BACKEND_URL`.

Configure the development backend's `ADMIN_ORIGIN` and Discord OAuth callback for the browser-facing Next.js origin, for example `http://localhost:3000` and `http://localhost:3000/admin/auth/callback`. Keep `localhost` and `127.0.0.1` consistent. Details are in [the backend development environment guide](../../backend/development-environment.md) and [the temporary preview/auth state guide](../temp-auth-state.md).
