# Railway monorepo runbook

## Install and run

Use Node 22.23.3. From the repository root:

```bash
npm ci
npm run build:stack
npm run validate:workspaces
npm run validate:handlers
npm run test:stack
npm run test:unit --workspace @uncs/web
```

Legacy remains `npm run build` then `npm start`. New production commands are:

```bash
npm start --workspace @uncs/api
npm start --workspace @uncs/bot
npm start --workspace @uncs/web
```

For development, build shared packages once, copy each app's example to its ignored local env file, then run `npm run dev --workspace @uncs/api`, `@uncs/bot`, or `@uncs/web` in separate terminals. API/bot load their working directory's `.env` in development; production ignores local env files. Web uses `.env.local`. Changes to shared packages require rebuilding them.

The prior ignored `apps/backend/.env` can be copied to `apps/api/.env` locally. Never commit it. Sample game mode (`BACKEND_GAME_MODE=sample`) replaces game transport while retaining real development auth/database sessions. It cannot be used in production or with workers/mutations enabled.

## Railway services

The supported declaration is [`.railway/railway.ts`](../../.railway/railway.ts), with three services named `monorepo-web`, `monorepo-api` and `monorepo-bot`. It selects this repository's `monorepo` feature branch and repository-root builds. Update that branch deliberately after review/merge.

| Service | Build command       | Start command                     |
| ------- | ------------------- | --------------------------------- |
| Web     | `npm run build:web` | `npm start --workspace @uncs/web` |
| API     | `npm run build:api` | `npm start --workspace @uncs/api` |
| Bot     | `npm run build:bot` | `npm start --workspace @uncs/bot` |

Create/link a **separate staging Railway project** for this declaration, keeping the legacy project/service and domains intact. The declaration manages only the new-stack resources and includes no database, domain, production credentials or migration step. Do not apply this three-resource graph to the existing production environment: omitted resources may be proposed for deletion. Inspect the complete plan before applying anything.

Railway's [current Infrastructure as Code documentation](https://docs.railway.com/infrastructure-as-code) says new services cannot opt into `railway.json`/`railway.toml`; existing files stop being read on December 1, 2026. The repository uses the supported TypeScript SDK rather than those retired per-service files. `npm run validate:railway` evaluates the declaration locally without contacting Railway. Deployment is a later explicit operation: link the intended new staging project, run `railway config plan`, inspect it, then apply only an approved plan.

The declaration supplies dependency watch paths, one replica per service, injected `PORT`, `/health/ready`, and limited process restarts. All processes bind `0.0.0.0`. `/health/live` reports process liveness. API readiness checks PostgreSQL without Discord; passive bot readiness does not log in, active bot readiness requires a ready gateway. Web readiness checks its API.

The initial API and bot controls in the declaration are explicitly false. Edit the declaration deliberately to enable isolated active operation; applying the unchanged declaration restores passive flags. Repository access, service origins, isolated database and secrets must be configured separately before startup can succeed. Single replicas and zero configured overlap are not leader election: disable workers/gateway and drain the previous active instance before rolling an API/bot deployment, then enable the new owner. Keep one active API worker and one active bot, including during updates.

## Configuration and credentials

Use isolated targets for verification; do not clone legacy production credentials into the new services.

| Setting                             | API                                     | Bot                      | Web                                       |
| ----------------------------------- | --------------------------------------- | ------------------------ | ----------------------------------------- |
| `DATABASE_URL`                      | Existing schema on isolated database    | Never                    | Never                                     |
| `DISCORD_BOT_TOKEN`                 | REST membership/permission verification | Gateway and delivery     | Never                                     |
| `BOT_TO_API_TOKEN`                  | Incoming bearer verifier                | Outgoing API bearer      | Never                                     |
| `API_TO_BOT_TOKEN`                  | Outgoing bot bearer                     | Incoming bearer verifier | Never                                     |
| `BOT_ORIGIN`                        | Bot HTTP origin                         | —                        | —                                         |
| `API_ORIGIN`                        | —                                       | API HTTP origin          | —                                         |
| `BACKEND_URL`                       | —                                       | —                        | API HTTP origin, set at build and runtime |
| `ADMIN_ORIGIN`                      | Exact new web browser origin            | —                        | —                                         |
| OAuth client/secret/session secret  | API only                                | Never                    | Never                                     |
| Game/RCON/telemetry/Patreon secrets | API only                                | Never                    | Never                                     |

Generate separate random bearer secrets of 32–512 printable ASCII characters. The two directions must differ. Use Railway private HTTP origins between services where available; authentication remains mandatory. Do not expose internal bot endpoints through browser forwarding. Web forwards `/admin/api`, exact auth routes, applicant routes and Patreon link callbacks; browser requests stay on the new dashboard's origin.

Set a distinct staging web hostname and register its exact `/admin/auth/callback` and applicant/Patreon callback URLs with the relevant providers. Configure API origins used by each existing feature (`ADMIN_ORIGIN`, application/Patreon origin settings) consistently with that hostname. Cookies remain host-only; keep legacy and staging on separate hosts, including local development. No domain routing changes are needed for parallel deployment.

API needs the legacy feature configuration for enabled applications, supporters, votes/events, community, alerts and role policy. Bot needs Discord guild/channel/role configuration for deliveries, welcomes, seeding, presence and conditional Patreon command registration. Keep these IDs consistent across services and isolated from production. See existing feature guides for settings and permission requirements.

## Secret rotation during the overlap

Follow the [secret rotation guide](../guides/SECRET_ROTATION.md), including rotation of every secret when ownership changes. Rotate staging credentials independently from legacy production credentials.

In the new stack, `ADMIN_SESSION_SECRET` belongs to the API. Rotating it cancels in-flight OAuth sign-ins and invalidates applicant session cookies; staff sessions remain stored in the database and require separate revocation to sign staff out. `DATABASE_URL` also belongs only to the API. After changing its database role password and closing old connections at the provider, update the API connection string and restart it; the bot and web have no database credentials to update. Readiness confirms database connectivity.

For internal transport, rotate `BOT_TO_API_TOKEN` on both the bot sender and API verifier, and `API_TO_BOT_TOKEN` on both the API sender and bot verifier. Keep the directions distinct. Disable API workers/mutations and the bot gateway while coordinating these restarts, verify authenticated calls after both sides match, then restore the intended isolated service ownership. Treat an interrupted mutation or Discord send as uncertain and inspect its receipt or reconciliation state before attempting another operation.

## Passive and active operation

Initial API:

```dotenv
API_WORKERS_ENABLED=false
API_MUTATIONS_ENABLED=false
```

Initial bot:

```dotenv
BOT_GATEWAY_ENABLED=false
```

Passive API permits reads/auth sessions/logout but blocks operational mutations, ingest and webhooks. Passive bot offers health and authenticated pure rendering only. Passive operation is not a staging worker owner.

For isolated active verification, configure both bearer directions and service origins, then set API mutations and workers true and bot gateway true. API workers require mutations enabled. Enable feature-specific flags deliberately. The bot declaration uses `NEST_ENV=development` initially; configure `DISCORD_DEVELOPMENT_GUILD_ID` so commands register only in the isolated guild. Change that mode deliberately for cutover. Confirm privileged intents in Discord settings. API readiness remains independent of bot availability.

## Verification and failure handling

Run clean-install builds, legacy suites, copied API contract tests, bot command/component/listener and delivery tests, client outage/malformed-response/credential tests, workspace validation and required lint/format/type checks. Verify compiled passive startup with no bot database/game credentials and no API gateway. Storage verification uses a disposable loopback test database and existing committed SQL fixtures; never point it at a populated database.

Then verify the new staging hostname and isolated active targets: OAuth/membership/MFA/CSRF, every page endpoint, versioned staff actions, commands and ballot acknowledgement, joins, worker schedules, messages/edits and role permissions. Break each service connection and inspect receipts/reconciliation. Do not retry an unknown mutation or send automatically. Preserve confirmed database changes even when later notification fails. Existing feature recovery is retained; process-local duplicate receipts expire/restart, and HTTP adds no durable outbox guarantee.

## Later cutover and rollback

1. Capture release versions, configuration, current pending receipts/votes/events and feature ownership. Confirm compatibility with the existing database schema.
2. Stop legacy workers and gateway **before** enabling new services against production. Legacy remains an available build/release; do not let two instances own automation or Discord registration.
3. Enable one API worker and one bot. Verify readiness, business reconciliation, message nonces, pending outcomes and permissions before moving web traffic.
4. Switch dashboard traffic/OAuth callbacks separately after verification. Keep callback/session origins consistent; expect independent sign-in on the new host.
5. For rollback, stop new workers/gateway/mutations first, inspect uncertain receipts and delivery state, then restore the legacy release and its original routing/configuration. Reconcile unknown outcomes before sending again. Do not reverse confirmed data merely because notification failed.

This runbook does not authorize deployments, domain changes, migration execution or production-target verification.
