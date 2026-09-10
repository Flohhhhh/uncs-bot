# Task Completion Requirements

- Format: `npm run format:check` passes globally. Use `npm run format -- <file ...>` to apply formatting.
- Lint: `npm run lint -- <touched-file ...>` passes for touched files
- Typecheck: `npm run typecheck -- <touched-file ...>` passes for touched files
- Handler registration/validation: `npm run validate:handlers` passes for command or event-handler changes.
- Whitespace Issues: `git diff --check` ran and passes

# Adding Discord slash commands

For requests to add a Discord slash command, follow the task-specific workflow in [`.agents/skills/discord-slash-command/SKILL.md`](.agents/skills/discord-slash-command/SKILL.md).

This repository uses NestJS 11, Necord 6, Discord.js 14, and TypeScript decorators. Command handlers belong in `src/commands/handlers/`, use an `@Injectable()` class, and must be included in the `HANDLERS` provider array in `src/commands/commands.module.ts`. `CommandsModule` is already imported by `AppModule`.

For a simple standalone command, use the repository generator:

```bash
npm run create:command -- <name> --description "<description>"
```

Inspect the generated handler, replace its placeholder response, and extend it with Necord option decorators when needed. For subcommands or interactive components, follow the patterns in the task-specific skill. Run the relevant completion checks above.

# Adding Discord event handlers

For requests to react to a Discord gateway event, follow [`.agents/skills/discord-event-handler/SKILL.md`](.agents/skills/discord-event-handler/SKILL.md).

Event handlers belong in `src/listeners/handlers/`, use an `@Injectable()` class, and must be included in the `HANDLERS` provider array in `src/listeners/listeners.module.ts`. Use `@On(Events.<Event>)` for repeated events and `@Once(Events.<Event>)` for one-time lifecycle events. Use the repository generator for ordinary listeners:

```bash
npm run create:listener -- <name> <event>
```

The generator validates the Discord.js event, derives its typed context parameters, creates the `.listener.ts` file, and wires it into `listeners.module.ts`. Confirm the required gateway intent in `src/bot/bot.module.ts` and in the Discord application settings when the intent is privileged. Run the relevant completion checks above.

# Centralized Discord logging

Command and event execution is logged automatically through the global interceptors in `src/common/logging/`. Command handlers should not add duplicate logging for the command name or user, and event handlers should not add duplicate logging for the event or actor unless they need to record additional feature-specific details. Both entry points delegate output to `ActivityLogger`.
