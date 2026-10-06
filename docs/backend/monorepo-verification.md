# Monorepo refactor verification

October 6, 2026. Local verification used Node 22.23.3, simulated Discord/game/provider responses, a fresh disposable PostgreSQL container, and a separate local browser session. No production service, domain, credentials, database, Discord guild or game target was changed.

## Results

| Check                                                                                                                                   | Result                             |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| One root `npm ci` in a clean source snapshot                                                                                            | Passed                             |
| Independent web, API, bot production builds in the clean snapshot                                                                       | Passed                             |
| Legacy Nest + Vite build in the clean snapshot                                                                                          | Passed                             |
| Legacy backend/business/handler tests                                                                                                   | 2,727 passed                       |
| Legacy browser workflow tests                                                                                                           | 869 passed                         |
| Existing storage/concurrency tests on disposable PostgreSQL                                                                             | 116 passed                         |
| New API contracts, permissions, receipts, HTTP bridge and business workers                                                              | 684 passed                         |
| New bot handlers, components, listeners, rendering, permissions and delivery                                                            | 185 passed                         |
| Shared client timeout, malformed response, credential and duplicate/unknown-outcome tests                                               | 7 passed                           |
| New web unit tests                                                                                                                      | 21 passed                          |
| Compiled API passive startup/readiness without a Discord gateway                                                                        | Passed                             |
| Compiled bot passive startup without database, game or bot credentials                                                                  | Passed                             |
| Passive worker bootstrap and manually scheduled timers                                                                                  | Passed                             |
| Simulated browser sign-in, selected-server navigation through every migrated admin page, logout and protected-route denial after logout | Passed; no browser errors/overlays |
| Production import/dependency boundary validation                                                                                        | Passed                             |
| Handler/component registration and command-name validation per bot application                                                          | Passed                             |
| Root formatting, touched-file lint, full workspace/legacy typecheck and `git diff --check`                                              | Passed                             |
| Bot command/listener generators in a disposable source snapshot                                                                         | Passed                             |
| Railway declaration evaluation without network/deployment commands                                                                      | Passed                             |

The clean source snapshot excludes ignored environment files, installed dependencies and compiled outputs. Legacy production source, Vite source, schema and committed migrations were left unchanged. Four legacy HTTP test fixtures now keep a single loopback listener per test to avoid intermittent failures from reopening ephemeral sockets during rate-limit loops. Storage tests loaded existing SQL fixtures only into the disposable test database; no migration-generation, push or production migration command ran. Local PostgreSQL verification used the available PostgreSQL 17 image; CI retains its existing pinned PostgreSQL 18 service.

## Coverage and limits

API tests exercise the copied API implementations, including staff/applicant auth, OAuth callbacks, server access, CSRF, settings/voting/event controls, supporter webhooks/Patreon linking, telemetry, application reviews, role management, worker scheduling and uncertain receipts. The HTTP bridge checks actual local bearer-authenticated transport to bot controllers, metadata/date validation, stable role ledger IDs, duplicate suppression, delivery failure and service outage. Bot tests cover copied Discord acknowledgement, permissions, message/nonces and rendering with simulated Discord clients.

Browser navigation uses the existing isolated preview as a fixture backend. It verifies forwarding/session UX and route switching, rather than real Discord OAuth or external game delivery. Real isolated Discord permission/intents/command registration, provider callbacks, game connectivity and Railway networking still require staging verification before production cutover. Railway deployments were not performed in this iteration.

Process-local duplicate suppression is not durable across restart. Existing business receipts, Discord nonces and reconciliation are retained; no outbox, schema change or new delivery guarantee was introduced. Confirmed database changes remain intact when later notification fails.

See the [runbook](railway-monorepo-runbook.md) for repeatable verification and later ownership transfer/rollback. Repository formatting, touched-file lint/typechecks, handler validation and whitespace checks accompany this report.
