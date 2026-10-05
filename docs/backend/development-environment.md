# Local backend development

The Next.js app connects to a local Nest backend at `http://127.0.0.1:4321`. The backend wrapper in `apps/backend` reuses the existing admin API, Discord OAuth, staff permissions and database-backed sessions, without starting the Discord gateway bot or background jobs. It uses root dependencies; there is no separate backend install.

## Configure

Copy `apps/backend/.env.example` to `apps/backend/.env` if needed. Add your development PostgreSQL URL, Discord OAuth application credentials, guild/staff role IDs, REST bot token and a unique session secret. Keep this file private; it is ignored by Git. The backend loads only this file, not the root `.env` or inherited shell variables. Your development database must already have the required schema; startup does not run migrations.

Set `ADMIN_ORIGIN=http://localhost:3000` and register `http://localhost:3000/admin/auth/callback` in the Discord OAuth application. Use `localhost` consistently in the browser and OAuth settings. The bot token is used for Discord REST role checks; this backend does not start a gateway connection.

In `apps/web/.env.local`, set:

```dotenv
BACKEND_URL=http://127.0.0.1:4321
```

Restart Next.js after changing its backend URL.

## Run

Install root dependencies and the standalone web dependencies once. Then run these commands from the repository root in separate terminals:

```bash
npm --prefix apps/backend run dev
npm --prefix apps/web run dev
```

Open <http://localhost:3000/admin> and sign in with Discord. The backend permits admin API reads and logout. Game writes are blocked.

## Sample game data

Set `BACKEND_GAME_MODE=sample` in `apps/backend/.env` and restart the backend to serve in-memory game fixtures alongside real Discord authentication and database sessions. `BACKEND_SAMPLE_SCENARIO` can be `standard` (six players), `full-server` (100 players) or `pre-round`. No separate preview process is needed; the web app continues using port 4321. The sample game data resets when the backend restarts. The default mode is `live`.

See [the backend README](../../apps/backend/README.md) for configuration details and available checks.
