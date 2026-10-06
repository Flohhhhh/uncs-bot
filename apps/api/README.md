# API

Independent Nest HTTP service, business workers, PostgreSQL stores and game connections. It owns no Discord gateway and serves no legacy Vite dashboard.

From the repository root: `npm ci`, `npm run build:api`, then `npm start --workspace @uncs/api`. Development: copy `.env.example` to the app-local ignored `.env`, build shared packages, then `npm run dev --workspace @uncs/api`.

Workers and operational mutations default off. Sample game mode is development-only. Production uses injected environment variables. Internal bot requests require their direction-specific bearer credential; Discord permissions are rechecked by the API.

See the [runbook](../../docs/backend/railway-monorepo-runbook.md) and [ownership state](../../docs/backend/monorepo-transition-state.md).
