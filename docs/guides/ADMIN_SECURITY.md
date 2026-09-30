# Staff dashboard security

Reviewed on September 30, 2026. These controls are implemented and covered by local tests. They do not certify the production deployment, Discord application settings, public website, database, or game host.

## Authentication and permissions

- Staff sign-in is disabled unless `ADMIN_ENABLED=true` and the Discord identity settings exist. RCON credentials are checked only when contacting the game; an unavailable game does not prevent access to application or supporter records. Production and staging require an exact HTTPS `ADMIN_ORIGIN`, without a path or trailing slash. Plain HTTP is accepted only on loopback during development.
- Discord sign-in requests only `identify`. A signed, random state cookie expires after five minutes, and callbacks exchange the authorization code on the server. Discord OAuth credentials and access tokens are never returned to the browser or stored in the dashboard session.
- Sign-in requires Discord's `mfa_enabled` field to be `true`. This proves that two-factor authentication is enabled at sign-in; it does **not** prove a new second-factor challenge was completed for this session or for each action. Disabling MFA after sign-in is not detected until the next sign-in. See [Discord's User resource](https://docs.discord.com/developers/resources/user).
- Access requires current membership in the configured guild and an explicitly configured owner ID or staff role ID. Discord's general Administrator permission does not grant access implicitly. Members still awaiting Discord membership screening are rejected.
- Reads may reuse a membership result for at most 30 seconds. Every mutation fetches current Discord membership and roles. Discord failures deny access; failed fresh checks invalidate cached membership. Permissions are checked by the server, regardless of which controls the browser displays.
- Sessions use random 256-bit tokens, store only a SHA-256 token hash, and expire after eight hours without sliding renewal. Sign-in replaces the browser's previous session; logout deletes it. HTTPS uses host-only `__Host-uncs_admin_session` and `__Host-uncs_admin_oauth` cookies with `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`. Never add a cookie Domain or rewrite cookie paths at a proxy.

## HTTP and game-server boundaries

The approved staff origin is `https://admin.theuncsgaming.com`; public applications remain on `https://theuncsgaming.com`. Configure `ADMIN_ORIGIN` and `APPLICATION_ORIGIN` separately. Their Discord callbacks are respectively `/admin/auth/callback` and `/apply/auth/callback`. The website adapter and production DNS still need verification before activating this split. There is no permissive CORS configuration. Every authenticated mutation requires its own exact matching origin and session CSRF token. Forwarded host/protocol headers cannot override this check.

Host-only cookies keep public and staff browser sessions separate. Never widen cookie domains or allow the public website origin to issue staff mutations. Applicant login is independently controlled by `WHITELIST_APPLICATIONS_ENABLED`, needs no staff role or RCON configuration, and cannot mint a staff session. Keep user content escaped and avoid untrusted third-party JavaScript on either origin.

The dashboard sets a restrictive Content Security Policy (including same-origin self-hosted fonts), frame denial, `nosniff`, no-referrer, same-origin resource policy, HTTPS HSTS, and `no-store` on `Cache-Control`, `CDN-Cache-Control`, and `Vercel-CDN-Cache-Control`. The deployment proxy must also disable caching for every `/admin` route, including authenticated JSON and OAuth responses. Verify that response headers and `Set-Cookie` survive the complete production proxy chain.

The application limits each authenticated user to 240 reads and 30 mutations per minute. Mutations also have the service's one-second spacing limit. Before authentication it limits each socket peer to 600 API requests and 60 OAuth requests per minute. Both counters have bounded memory and expire after one minute. These are per-process limits; they reset on restart and are not a distributed denial-of-service defense. Caller-supplied `X-Forwarded-For` is deliberately ignored. Behind Vercel/Railway, peer limits are shared across clients arriving through the same proxy, so configure client IP rate limits at the trusted edge too.

The game endpoint and bearer password exist only in server configuration. Requests use a fixed server endpoint and an explicit action allowlist; the browser cannot supply an arbitrary RCON path or configuration document. Strict payload schemas reject unknown fields. Audit recording must succeed before an action is sent. An uncertain request result is recorded as unknown rather than automatically retried.

HTTP RCON endpoints are supported because some game providers expose them that way; this does not encrypt the bearer password on the network. Prefer HTTPS or a private, protected connection between Gramps and the game host. Check the actual provider network path, current RCON host controls, and firewall before connecting production. Browser HTTPS does not protect a separate plaintext backend connection.

## Dependencies and runtime

Safe updates within the existing package ranges reduced `npm audit` from 45 reported dependency findings (1 critical, 19 high, 21 moderate, 4 low) to **4 moderate and no high or critical findings**. The four remaining entries are one dependency chain:

`drizzle-kit@0.31.11` → `@esbuild-kit/esm-loader@2.6.5` → `@esbuild-kit/core-utils@3.3.2` → `esbuild@0.18.20`.

The underlying issue is [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99), concerning the esbuild development server accepting cross-origin requests. These packages are installed as existing database tooling; the dashboard and bot source do not import that chain or start its development server. Do not expose development servers or database studio publicly. `npm audit fix --force` proposes an incompatible Drizzle Kit downgrade and was deliberately not applied. The advisory is still present in the installed dependency graph, including the production dependency audit; it has not been waived or hidden.

The project now requires Node **22.23.3 or a newer 22.x patch** and pins Volta to 22.23.3. The [September 23 Node release](https://nodejs.org/en/blog/release/v22.23.3) includes current OpenSSL and Undici updates. Updating npm packages alone does not update Node's built-in HTTP client. Verify the deployed Node version explicitly. Local security tests also passed with a separately downloaded Node 22.23.3 executable verified against the official SHA-256 manifest; the machine's global Node installation was not changed.

The active September 30 production rebuild (`bbbad04a`) reports `process.version` as `v22.23.3`. Gramps logged in to one guild and reloaded its commands. All 13 loopback probes passed their expected response and cache/cookie/redirect checks, including unavailable protected routes with the feature flags off. Public HTTPS routing, OAuth and RCON are not configured or verified by those internal checks.

## Deployment and incident checks

The production launch migration was applied on September 30 through Railway's existing pre-deploy command after the owner explicitly approved the identified production target and deployment with new features off. Read-only schema, migration-journal and welcome-data preservation checks passed; see [Database prerequisite](ADMIN_DASHBOARD.md#database-prerequisite--launch-migration-applied). The general human-only migration rule remains in place for future work.

Before exposure, verify explicit staff IDs, the exact Discord redirect URI, HTTPS, proxy cache bypass, host-only cookies, origin rejection, and successful role removal. OAuth, RCON and the public backend hostname are not yet configured; the new feature flags remain off. Exercise a read and an authorized harmless action against the actual game build; unit tests cannot prove its live RCON behavior.

Use `ADMIN_ENABLED=false` to disable all authenticated dashboard access during an incident. Revoking a staff role blocks their next mutation and subsequent uncached reads. To invalidate every session, a database operator must remove the dashboard session records; rotating `ADMIN_SESSION_SECRET` alone only invalidates outstanding OAuth state cookies, not already-issued sessions. RCON, Discord client, and bot credentials need their own rotation if compromised. Keep secrets, cookie headers, raw configuration documents, and OAuth callback query strings out of request logging at every proxy and host.

The local auth, HTTP-boundary, and settings suites cover missing/expired sessions, forged/expired OAuth state, MFA-required sign-in, session rotation, hashed lookup, role removal, Discord outage, CSRF/origin rejection, role enforcement, traffic limits, secret-safe errors, and response headers. They use mocked external services and an isolated test store; no production credentials, live bans, whitelist changes, or database migrations are used.
