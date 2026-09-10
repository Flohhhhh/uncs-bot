---
name: discord-slash-command
description: Create or extend a Discord slash command in this repository using its NestJS, Necord, and Discord.js architecture.
---

# Discord Slash Command

Use this skill when an agent is asked to add a new Discord slash command or slash-command subcommand to this bot. Keep the implementation consistent with the repository instead of introducing another command framework or registration mechanism.

## Repository conventions

- Runtime stack: NestJS 11, Necord 6, Discord.js 14, TypeScript with decorators and NodeNext modules.
- Command handlers live in `src/commands/handlers/`, one handler per file using a `.command.ts` suffix.
- Every handler is an `@Injectable()` class and must be included in the `HANDLERS` provider array in `src/commands/commands.module.ts`.
- `CommandsModule` is already imported by `AppModule`; do not add a command directly to `AppModule`.
- Use the existing `src` path alias for imports from `src/...`, or a relative import when that is the local convention.
- The project uses double quotes, Prettier formatting, and strict null checks. Follow the existing code style.
- Use the existing Necord and Discord.js dependencies; do not add packages unless explicitly requested.
- Command execution is logged centrally by `src/common/logging/command-logging.interceptor.ts`; do not add duplicate per-command logging unless the feature needs extra details.

## Implementation workflow

1. Determine whether the request is for a standalone command, a subcommand, options, permissions, guild-only scope, or interactive components.
2. For a simple standalone command, use the repository generator:

   ```bash
   npm run create:command -- <name> --description "<description>"
   ```

   The generator is implemented in [`scripts/create-command.ts`](../../../scripts/create-command.ts). It creates `src/commands/handlers/<name>.command.ts` and wires its class into `src/commands/commands.module.ts`. Inspect the generated file and replace its placeholder reply.

3. For options, use Necord decorators such as `@StringOption`, `@BooleanOption`, `@NumberOption`, `@IntegerOption`, `@UserOption`, `@RoleOption`, `@ChannelOption`, `@MentionableOption`, or `@AttachmentOption`. Define options in a local options class and inject them with `@Options()`.
4. For subcommands, use `createCommandGroupDecorator`, apply the group decorator to the handler class, and use `@Subcommand({ name, description })`. For nested subcommands, compose a second group decorator with `applyDecorators`.
5. Add permissions and context restrictions only when the feature requires them. Use the existing `RequiredMemberPermission` and `RequiredBotPermission` guards, plus Discord.js `defaultMemberPermissions` and `contexts` metadata where appropriate.
6. If the command creates buttons, select menus, or modals, keep command-specific handlers near the command. Use slash-separated fixed custom IDs; use Necord dynamic `:` parameters only when values need to be extracted with `@ComponentParam` or `@ModalParam`.
7. Acknowledge each interaction exactly once with `reply`, `deferReply` followed by `editReply`, or `update`/`deferUpdate` followed by the appropriate edit. Use ephemeral replies for private confirmations or errors where appropriate.
8. Inject existing Nest providers through the constructor. Do not instantiate a service directly when it is already registered for dependency injection.

## Canonical standalone command

```ts
import { Injectable } from "@nestjs/common";
import { Context, SlashCommand, type SlashCommandContext } from "necord";

@Injectable()
export class ExampleCommand {
  @SlashCommand({
    name: "example",
    description: "Describe what this command does",
  })
  async handleExample(@Context() [interaction]: SlashCommandContext) {
    return interaction.reply("Response");
  }
}
```

When not using the generator, add the class import and class name to `HANDLERS` in `src/commands/commands.module.ts`. Do not register a root command separately when it contains subcommands; Discord treats that as a different command shape.

## Verification

- Search `src` for the command name and handler class to confirm there is one intended registration and no stale placeholder.
- Run `npm run lint` and `npm run build` when dependencies are installed.
- Run `git diff --check` and inspect the diff for unintended changes.
- Report inability to run checks, such as missing `node_modules`, rather than claiming the command was compiled or tested.

For the project’s layout rationale, consult [`guides/PROJECT_STRUCTURE.md`](../../../docs/guides/PROJECT_STRUCTURE.md). For generator behavior, consult [`scripts/create-command.ts`](../../../scripts/create-command.ts).
