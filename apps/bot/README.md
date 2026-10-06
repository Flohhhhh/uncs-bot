# Bot

Independent Discord gateway, handlers, message rendering/delivery and role writes. Business requests use authenticated API calls. No database credentials or game secrets are needed.

From the repository root: `npm ci`, `npm run build:bot`, then `npm start --workspace @uncs/bot`. Development: copy `.env.example` to the app-local ignored `.env`, build shared packages, then `npm run dev --workspace @uncs/bot`.

`BOT_GATEWAY_ENABLED` defaults off. Passive startup exposes health and authenticated pure rendering, with no Discord login or registration. Configure separate bearer directions and isolated Discord targets before enabling it. Production ignores local env files.

See the [runbook](../../docs/backend/railway-monorepo-runbook.md).
