# Monorepo transition state

Updated October 6, 2026. The page port and service extraction are implemented. Deployment and production cutover are separate tasks.

## Applications and ownership

| Application | Ownership                                                                                           | Initial hosting                     |
| ----------- | --------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `apps/web`  | Next.js pages, same-origin API/auth forwarding, session UX                                          | Separate Railway service            |
| `apps/api`  | OAuth, sessions, permissions, PostgreSQL stores, game connections, business state, workers          | Separate Railway service            |
| `apps/bot`  | Discord gateway, commands, listeners, components, presence, message rendering/delivery, role writes | Separate Railway service            |
| Root legacy | Existing combined Nest service and Vite dashboard                                                   | Existing Railway service, unchanged |

The API replaces the development wrapper previously named `apps/backend`. Its source is copied locally; it does not import legacy modules. The bot has no database connection or game transport. Shared `@uncs/contracts` schemas contain serializable DTOs; `@uncs/api-client` supplies bounded authenticated HTTP calls and process-local duplicate suppression.

The API includes the existing admin, applicant, Patreon callback/webhook, supporter, telemetry, voting, events, announcements, role-management and settings interfaces. Legacy HTML/static-dashboard serving is excluded from the API. Root `build`, `start`, environment handling, Vite dashboard and committed migrations remain available independently.

## Runtime boundary

Bot business requests use feature-specific `/internal/v1` routes. The API independently checks current Discord membership and applicable permissions before writes; a supplied staff role is not authority. API delivery requests use explicit bot routes for role checks/writes, ballots, weekly posts, staff alerts, community edits and Patreon panels. Weekly rendering is a pure bot endpoint that works without a gateway.

Each direction has a distinct bearer secret. Cookies are rejected on internal routes, and neither secret belongs in web configuration. HTTP transport does not retry. Unknown results retain their feature's existing receipt/reconciliation behavior. Process-local receipts suppress duplicate requests until restart; they are not durable delivery guarantees. Existing business records, nonces and reconciliation remain responsible for restart recovery. No outbox or database change was introduced.

## Operational state

New examples default to passive operation:

- `API_WORKERS_ENABLED=false`: no business bootstrap jobs or manually scheduled worker timers.
- `API_MUTATIONS_ENABLED=false`: operational HTTP writes are blocked. OAuth session creation and logout remain available.
- `BOT_GATEWAY_ENABLED=false`: no Discord login, registration, listeners or delivery.

Sample game mode remains development-only and requires passive operation. Production loads injected variables rather than local dotenv files. Readiness checks work with no API Discord gateway; bot readiness reports passive or checks the active gateway.

Legacy remains the production owner. New deployments must use simulations or isolated targets until a deliberate cutover. Do not enable both legacy and new workers/gateways against the same production targets.

## Build and verification

Use Node 22.23.3 and one root `npm ci`. App manifests declare their dependencies. Root `build:api`, `build:bot`, `build:web` and `build:stack` build the new stack; root `build` still builds legacy. `test:stack`, workspace typechecks, import validation and handler validation are included in CI alongside legacy suites.

See [Railway runbook](railway-monorepo-runbook.md) for commands, independent origins, credentials, ownership transfer and rollback. Deployment checks with real isolated Discord/game targets are required before production cutover; local simulations cannot establish external permissions or network reachability.
