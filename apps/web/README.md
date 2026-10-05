# UNCs web app

Standalone Next.js 16 App Router app. Install inside this directory; it has its own package manifest and lockfile. It is intentionally not an npm workspace yet.

## Local development

Use the repository's Node 22.23.3 runtime:

```bash
cd apps/web
npm ci
npm run dev
```

Open http://127.0.0.1:3000. The index redirects to `/admin`; staff sessions gate the admin UI. Nest authorizes every API request.

```bash
npm test              # All unit tests, including preview authentication
npm run test:watch    # Watch tests during development
npm run preview:backend # Session-mode backend preview on port 4320 (separate terminal)
npm run verify        # Formatting, lint, typecheck and unit tests
npm run check         # ESLint and TypeScript (including Next route types)
npm run build         # Production build with Turbopack
npm start             # Serve the production build
npm run format:check
npm run format:write
npm run format -- src/path/to/file.tsx # Format selected files
```

The root bot install, build and start commands still operate independently. Install root dependencies separately with `npm ci` from the repository root. Root lint includes the web app when its dependencies are installed. Root formatting always covers it, using basic formatting on backend-only installs and the app’s Tailwind-aware formatter when available; root touched-file typechecking routes web files to this app's TypeScript project. Backend TypeScript projects exclude `apps/`.

The preview shortcut invokes the existing root preview command; root dependencies must be installed. It defaults to session mode and port 4320; `PREVIEW_PORT` can override the port. The preview implementation stays shared with the existing dashboard.

Tests live in `tests/unit/<domain>`; future browser tests belong in `tests/e2e/<domain>`. Shared Vitest setup is in `tests/setup.ts`.

## Conventions

- `src/app/(pages)` owns the index redirect and future public pages.
- `src/app/(admin)/admin` owns `/admin`, with a separate admin layout.
- `src/app/(auth)` owns `/sign-in` and `/access-denied` with a centered layout.
- Route groups share the root layout, theme and staff session providers, nuqs App Router adapter and theme-aware Sonner toaster. Group names do not appear in URLs.
- Strict TypeScript with `~/` imports, Tailwind 4, system fonts, and shadcn New York / Radix / neutral tokens / Lucide.
- Add official shadcn components from this directory using `npx shadcn@latest add <component>`.
- React Hook Form + Zod 4, SWR, nuqs and TanStack Table are available for future features. SWR has no global polling, fetcher or retry overrides.

## Environment and backend integration

No environment file or credentials are required. `src/env.ts` validates `NODE_ENV` and the optional server-only `BACKEND_URL`.

During `npm run dev`, `/admin/api/*` rewrites to the local Nest preview at `http://127.0.0.1:4320`. Exact GET handlers for `/admin/auth/login` and `/admin/auth/callback` forward to Nest, preserving cookies and callback parameters. OAuth forwarding allows 45 seconds and returns sanitized failure messages. Override the target with server-only `BACKEND_URL` in `apps/web/.env.local`, then restart Next.js. Production API rewrites require `BACKEND_URL` at build time; configure it at runtime for the OAuth handlers too.

To exercise sign-in, reload and logout without Discord or a database, run these in separate terminals from the repository root:

```bash
PREVIEW_PORT=4320 PREVIEW_AUTH_MODE=session npm run preview:admin
npm --prefix apps/web run dev
```

Use `http://127.0.0.1:3000` consistently. Demo login issues a random HttpOnly cookie backed by an isolated in-memory session, valid for eight hours; logout invalidates it. Restarting the preview clears all sessions. The preview's default mode remains automatic demo authentication for the existing dashboard. Both Next.js loopback origins on port 3000 are allowed for writes, with CSRF validation still required.

For real development OAuth, use [the local backend wrapper](../backend/README.md) with your development database: `npm --prefix apps/backend run dev` from the repository root. Set `BACKEND_URL=http://127.0.0.1:4321` in this app. The wrapper reads its own `apps/backend/.env`, starts no gateway bot/background jobs, and allows reads plus logout. Nest's `ADMIN_ORIGIN` must be the browser-facing Next.js origin, for example `http://localhost:3000`. Register `http://localhost:3000/admin/auth/callback` as the Discord OAuth callback. Use the same hostname for the browser, Nest's origin setting and the callback: localhost and 127.0.0.1 are different cookie/origin contexts. Keep Nest's role, MFA, membership and CSRF checks; forwarding does not rewrite origins to bypass them. No production configuration is changed by this app.

The development backend can also serve sample game data on port 4321 with `BACKEND_GAME_MODE=sample`, while keeping real Discord sessions. The status indicator labels sample data separately; see [backend sample mode](../backend/README.md).

Staff identity and CSRF stay in memory; the browser uses Nest's existing HttpOnly session cookies. Sessions are checked on load, every 30 seconds while authenticated and visible, and on focus, with a ten-second timeout. A 401 or 403 clears staff data and removes protected content. Malformed responses and connection failures show retry UI. Logout hides protected content immediately and sends one CSRF-protected POST; uncertain failures require manual retry. The admin status indicator uses this same session state.

The client-side layout gate is UI protection. Nest remains the authorization boundary for all data/actions; future server-side admin data fetching must also verify sessions rather than relying on this gate.

For future backend configuration, add server-only variables (such as `BACKEND_URL`) to the `server` schema and explicitly map them in `runtimeEnv`. Read secrets only from server modules marked with `import "server-only"`. Never expose service credentials with a `NEXT_PUBLIC_` prefix. Browser-visible variables belong in the `client` schema with the matching prefix and explicit mapping.

The current Nest service retains Discord OAuth, sessions, permissions and database ownership. This app has no Better Auth, database client, CMS, uploads or monitoring setup.

## Future Vercel deployment

Connect this repository with the Next.js framework preset and Root Directory set to `apps/web`. Use `npm ci`, `npm run build` and the default Next.js output settings. Keep Node on 22.x. Turbopack's root is explicitly this app, and Tailwind scans only its own source.

Do not change Railway's current root install/build/start commands for this scaffold. Pushing this branch may still trigger Railway according to its deployment settings; the directory itself does not control deployment triggers.
