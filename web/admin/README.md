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

`src/api` contains the same-origin client, JSON types and cancellable resource hook; `src/app` owns session lifetime, routes and the single 20-second refresh loop. Each feature owns its page/forms. Polling pauses when the tab is hidden, a review dialog is open or an action is running. Session denial unmounts all staff views; late responses from earlier sessions are rejected. Mutations are never automatically retried. Bulk team moves remain sequential and stop on a failed or uncertain result.

The former `src/admin/public/app.js`, HTML shell, duplicated CSS/assets and hard-coded individual asset controllers are removed. Existing game/business logic, database schemas, credentials, public website hosting and production feature flags are unchanged by this frontend conversion. The React UI retains the malformed-whitelist-row display fix from cleanup PR #5.

Before production release, review this change separately from cleanup PR #5 and reconcile the live deployment settings with Floh. Tests and previews do not authorize exercising game actions against the live server.
