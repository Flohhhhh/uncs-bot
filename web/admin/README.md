# Gramps staff dashboard

React and TypeScript own the browser interface; Vite builds static files. Nest continues to own Discord sign-in, role checks, CSRF, audit records, application/supporter decisions and the game connection. The public community website remains in its separate repository.

Use the repository's pinned Node 22.23.3 and install with `npm ci` from the repository root. One package manifest and lockfile cover the existing service and its browser build.

- `npm run build`: build Nest first, then typecheck and build the browser into `dist/src/admin/public`. Nest cleans `dist`, so reversing this order removes the browser build.
- `npm run test:admin`: build the browser assets, then run the existing Nest HTTP/service tests against mocked dependencies.
- `npm run test:frontend`: run browser component and client tests with simulated responses.
- `npm run preview:admin`: build and start the existing isolated Nest preview on loopback port 4317. All game, staff and database providers in that preview are simulated. Set `PREVIEW_PORT=4320` to use a separate port.
- `npm run dev:admin`: optional Vite development server on loopback port 4319. Start the isolated preview on port 4320 first; only `/admin/api` and `/admin/auth` are proxied to it.
- `npm run typecheck:admin`: check the browser's strict TypeScript project separately from the backend compiler.

Production runs only the existing Nest process. It serves the compiled public assets and explicit dashboard routes under `/admin`. React Router handles section navigation and back/forward; reloading a section still returns the dashboard shell. Unknown API/auth/file paths return errors, never the application HTML. No secrets belong in Vite variables or browser code. No `VITE_` credentials or local-storage session tokens are used.

`src/api` contains the same-origin client, JSON types, session/overview validators and cancellable resource hook; `src/app` owns session lifetime, routes and the single 20-second refresh loop. Each feature owns its page/forms. Polling pauses when the tab is hidden, a review dialog is open, an action is running or a read is still pending. History and private-record pages do not request a game overview, except while a bulk whitelist approval dialog is open: it reads the overview once for the game's request allowance. A game snapshot loses action authority after 60 seconds, leaving a game page, or a tab-visibility change. Reads time out after 45 seconds and writes after 60 seconds. Session-denial headers unmount staff views immediately; late write responses from earlier sessions remain uncertain. Mutations are never automatically retried, with one exception: a bulk whitelist approval sends an approval again, with the same review ID, after the server answers 429, which it does before reading the request. Bulk team moves remain sequential and stop on a failed, uncertain or stale result. Bulk whitelist approvals are sequential too and stop at the first answer that is not a confirmed approval (see [Whitelist applications](../../docs/guides/WHITELIST_APPLICATIONS.md#approving-several-at-once)).

The former `src/admin/public/app.js`, HTML shell, duplicated CSS/assets and hard-coded individual asset controllers are removed. Existing game/business logic, database schemas, credentials, public website hosting and production feature flags are unchanged by this frontend conversion. The React UI retains the malformed-whitelist-row display fix from cleanup PR #5.

Before production release, review this change separately from cleanup PR #5 and reconcile the live deployment settings with Floh. Tests and previews do not authorize exercising game actions against the live server.

The [release audit](../../docs/guides/ADMIN_RELEASE_AUDIT.md) records verified fixes and outstanding production integration checks. Compressed WOFF2 fonts replace the original TTF delivery without changing glyphs or metrics; their license notices remain alongside the assets.
