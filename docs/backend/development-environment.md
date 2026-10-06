# Local monorepo development

The Next.js app uses the independently runnable API at `http://127.0.0.1:4321`. The old `apps/backend` wrapper has been replaced by `apps/api`.

## Configure

Copy `apps/api/.env.example` to `apps/api/.env`. Supply an isolated development PostgreSQL URL, Discord REST/OAuth credentials, guild/staff role IDs and a unique session secret. The database must already have the existing schema; startup does not run migrations. API development loads its working-directory env file and allows shell overrides; production uses injected variables only.

Set `ADMIN_ORIGIN=http://localhost:3000` and register `http://localhost:3000/admin/auth/callback` with the isolated Discord application. Keep browser/callback hostnames consistent. API needs a REST token but starts no gateway.

In ignored `apps/web/.env.local`:

```dotenv
BACKEND_URL=http://127.0.0.1:4321
```

Restart Next.js after changes. Keep API workers/mutations false and bot gateway false until isolated targets are deliberately configured.

## Run

Install every workspace once from the root, build shared packages, then run separate terminals:

```bash
npm ci
npm run build:packages
npm run dev --workspace @uncs/api
npm run dev --workspace @uncs/web
```

For the bot, copy its own example, configure HTTP credentials/origins and isolated Discord IDs, then run `npm run dev --workspace @uncs/bot`. No database or game credentials belong there.

## Sample game data

Set `BACKEND_GAME_MODE=sample` in the API's ignored local `.env`; both API runtime controls must remain false. `BACKEND_SAMPLE_SCENARIO` accepts `standard`, `full-server`, or `pre-round`. Game transport uses in-memory fixtures while Discord authentication/database sessions remain real development dependencies. Sample mode is forbidden in production.

See the [runbook](railway-monorepo-runbook.md) for deployment, ownership, verification and rollback.
