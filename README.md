# The UNCs Discord Bot

A NestJS Discord bot for The UNCs community, built with [Necord](https://necord.org/) and [Discord.js](https://discord.js.org/).

The bot currently includes:

- Slash commands for health checks, uptime, user information, message cleanup, and welcome configuration.
- Welcome messages triggered when members join a guild.
- Persistent guild welcome settings stored in Neon PostgreSQL through Drizzle ORM.
- Local development support with a separate Discord application and personal Neon database branch.

## Local development

Use a development Discord bot and your own Neon database branch. Do not use the production bot token or production database locally.

```bash
npm install
cp .env.example .env
```

Set these values in `.env`:

```env
DISCORD_BOT_TOKEN="your-development-bot-token"
DATABASE_URL="your-personal-neon-branch-connection-string"
NEST_ENV="development"
DISCORD_DEVELOPMENT_GUILD_ID="your-test-discord-server-id"
```

To setup your branch, apply the committed schema to your personal Neon branch, then start the bot:

```bash
npm run db:migrate
npm run dev
```

Because `NEST_ENV` is `development`, slash commands are registered against `DISCORD_DEVELOPMENT_GUILD_ID` and update quickly while developing.

## Database workflow for contributors

Each contributor should work from their own Git branch and use their own personal/child Neon development branch. Their local `DATABASE_URL` should point to that personal Neon branch URL, never to production or another contributor's database.

During feature development:

1. Edit `src/database/schema.ts` if the feature needs schema changes.
2. Use `npm run db:push` against your personal Neon branch while iterating on your changes.
3. Do not use `db:push` against production or a shared database.
4. Do not create migration files during ordinary feature development.

Once feature branches have been merged into `development` and the combined schema changes are ready, a human contributor should generate and review one migration on the `development` branch. That migration is included in the pull request from `development` to `main`:

```bash
npm run db:generate
git diff -- drizzle/
git add src/database/schema.ts drizzle/
git commit -m "chore(db): add migration"
git push
```

Never edit a migration that has already been applied; create a new migration for follow-up schema changes.

The `development → main` pull request runs the migration-drift CI check. Pull requests from individual contributor branches do not generate migrations or modify database state.

Railway applies committed migrations through the service's Pre-deploy Command:

```text
npm run db:migrate
```

The production bot starts only after pending migrations succeed.

## Useful commands

```bash
npm run dev             # Run locally with watch mode
npm run build           # Build the production bundle
npm start               # Run the built bundle
npm run db:push         # Prototype schema changes on your personal DB branch
npm run db:generate     # Human-owned migration generation step
npm run db:migrate      # Apply committed migrations
npm run db:studio       # Open Drizzle Studio
npm run format:check    # Check formatting
npm run lint            # Run ESLint
npm run typecheck       # Run TypeScript checks
```

## Documentation

- [Setup guide](docs/guides/SETUP.md) — Discord, Neon, local, and Railway setup.
- [Project structure](docs/guides/PROJECT_STRUCTURE.md) — repository organization.
- [Scripts guide](docs/guides/SCRIPTS.md) — available development scripts.
- [REST API guide](docs/guides/REST_API.md) — enabling the optional HTTP API.
