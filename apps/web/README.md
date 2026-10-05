# UNCs web app

Standalone Next.js 16 App Router app. Install inside this directory; it has its own package manifest and lockfile. It is intentionally not an npm workspace yet.

## Local development

Use the repository's Node 22.23.3 runtime:

```bash
cd apps/web
npm ci
npm run dev
```

Open http://localhost:3000. The index redirects to `/admin`, which currently shows a public placeholder. There are no auth guards, game actions or backend calls in this scaffold.

```bash
npm run check         # ESLint and TypeScript (including Next route types)
npm run build         # Production build with Turbopack
npm start             # Serve the production build
npm run format:check
npm run format:write
```

The root bot install, build and start commands still operate independently. Install root dependencies separately with `npm ci` from the repository root. Root lint includes the web app when its dependencies are installed. Root formatting always covers it, using basic formatting on backend-only installs and the app’s Tailwind-aware formatter when available; root touched-file typechecking routes web files to this app's TypeScript project. Backend TypeScript projects exclude `apps/`.

## Conventions

- `src/app/(pages)` owns the index redirect and future public pages.
- `src/app/(admin)/admin` owns `/admin`, with a separate admin layout.
- `src/app/(auth)` reserves a centered layout for future authentication pages. It has no routes yet and does not implement login.
- Route groups share the root layout, theme provider, nuqs App Router adapter and theme-aware Sonner toaster. Group names do not appear in URLs.
- Strict TypeScript with `~/` imports, Tailwind 4, system fonts, and shadcn New York / Radix / neutral tokens / Lucide.
- Add official shadcn components from this directory using `npx shadcn@latest add <component>`.
- React Hook Form + Zod 4, SWR, nuqs and TanStack Table are available for future features. SWR has no global polling, fetcher or retry overrides.

## Environment and backend integration

No environment file or credentials are required. `src/env.ts` validates `NODE_ENV` and the optional server-only `BACKEND_URL`.

During `npm run dev`, `/admin/api/*` and `/admin/auth/*` are forwarded to the local Nest preview at `http://127.0.0.1:4320`. Start it from the repository root with `PREVIEW_PORT=4320 npm run preview:admin`. Override the target with `BACKEND_URL` in `apps/web/.env.local`, then restart Next.js. Production builds only enable these rewrites when `BACKEND_URL` is explicitly set at build time.

These forwarding rules do not implement login or change the backend's origin/CSRF policy; those require verification before browser writes or real OAuth login.

When backend integration is implemented, add server-only variables (such as `BACKEND_URL`) to the `server` schema and explicitly map them in `runtimeEnv`. Read secrets only from server modules marked with `import "server-only"`. Never expose service credentials with a `NEXT_PUBLIC_` prefix. Browser-visible variables belong in the `client` schema with the matching prefix and explicit mapping.

The current Nest service retains Discord OAuth, sessions, permissions and database ownership. This app has no Better Auth, database client, CMS, uploads or monitoring setup.

## Future Vercel deployment

Connect this repository with the Next.js framework preset and Root Directory set to `apps/web`. Use `npm ci`, `npm run build` and the default Next.js output settings. Keep Node on 22.x. Turbopack's root is explicitly this app, and Tailwind scans only its own source.

Do not change Railway's current root install/build/start commands for this scaffold. Pushing this branch may still trigger Railway according to its deployment settings; the directory itself does not control deployment triggers.
