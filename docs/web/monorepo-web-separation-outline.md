# Monorepo roadmap

Updated October 6, 2026.

## Implemented repository work

- [x] Port all scoped admin pages to Next.js, using route-local components and SWR.
- [x] Fix shared overview cache contracts during navigation.
- [x] Introduce npm workspaces and one root lockfile, retaining legacy root commands.
- [x] Replace the development wrapper with an independently compiled `apps/api`.
- [x] Copy Discord commands, listeners, components, logging, presence and delivery into `apps/bot`.
- [x] Add plain shared contracts and authenticated HTTP transport.
- [x] Separate database/game business operations from Discord gateway and delivery.
- [x] Preserve existing schema and committed migrations; no migration work in this refactor.
- [x] Add passive runtime controls, readiness, shutdown and separate Railway configurations.
- [x] Extend tooling, generators, handler validation and CI to support both stacks.

These decisions supersede the earlier Vercel-first hosting and persisted delivery-work proposal: initial hosting is Railway for all three new services, delivery uses authenticated HTTP with existing feature recovery, and no outbox is introduced.

## Next: deploy alongside legacy

1. Review the service extraction and [runbook](../backend/railway-monorepo-runbook.md).
2. Create three **new** Railway services using the supported TypeScript infrastructure declaration and repository-root builds. Keep the existing legacy service and domain routing intact.
3. Deploy API and bot passively, and web on a separate staging hostname. Give the new dashboard its own OAuth callback and session secret.
4. Use isolated database, Discord application/guild, game connections and Patreon/webhook fixtures to verify active workers, commands, deliveries and failure recovery.
5. Record parity and operational evidence: auth, all page contracts, mutations, uncertain outcomes, scheduler ownership, shutdown, logs and readiness.
6. Approve an ownership transfer window. Stop legacy automation/gateway before enabling new production workers/gateway. Keep one API worker replica and one bot replica initially.
7. Move dashboard traffic only after the separate new hostname passes verification. Retain a runnable legacy release and a documented rollback.

## Ongoing constraints

Legacy production credentials and targets stay unchanged during parallel verification. New apps must not import another app's implementation or root legacy source. Service secrets remain server-side. Database changes remain additive and compatible during overlap and require human-owned reviewed migrations. Production deployment and domain changes are not part of the repository refactor.

## Architecture

```text
Browser -> Web -> API -> PostgreSQL / game servers / business integrations
Discord -> Bot -> authenticated API business endpoints
API workers -> authenticated Bot delivery/metadata endpoints -> Discord
Legacy -> existing production targets until deliberate cutover
```

Web forwards browser requests on its own origin; API verifies authorization. Bot authorization context is checked against current Discord roles by the API. Feature-specific receipts, nonces and reconciliation preserve existing uncertainty behavior; HTTP mutations are never automatically retried.
