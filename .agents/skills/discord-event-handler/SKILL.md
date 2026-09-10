---
name: discord-event-handler
description: Create or extend a Discord gateway event handler in this repository using its NestJS, Necord, and Discord.js architecture.
---

# Discord Event Handler

Use this skill when an agent is asked to react to a Discord gateway event in this bot. Keep the implementation consistent with the repository instead of adding a second event-registration system.

## Repository conventions

- Runtime stack: NestJS 11, Necord 6, Discord.js 14, TypeScript with decorators and NodeNext modules.
- Event handlers live in `src/listeners/handlers/`, one handler per file using a `.listener.ts` suffix.
- Every listener is an `@Injectable()` class and must be included in the `HANDLERS` provider array in `src/listeners/listeners.module.ts`.
- `ListenersModule` is already imported by `AppModule`; do not add listeners directly to `AppModule`.
- Use `Events` from `discord.js` for event identifiers and Necord’s `@On`/`@Once` decorators for registration.
- Use `@Context()` with `ContextOf<Events.SomeEvent>` so the handler parameters match Discord.js’s `ClientEvents` tuple.
- Use the existing dependencies and project style: double quotes, Prettier formatting, and strict null checks.
- Event execution is logged centrally by `src/common/logging/event-logging.interceptor.ts`; do not add duplicate per-event logging unless the feature needs extra details.

## Implementation workflow

1. Identify the exact Discord.js event and whether it should run for every occurrence (`@On`) or only once during the client lifecycle (`@Once`). `ClientReady` is a typical `@Once` event; member joins are typically `@On`.
2. For a normal listener, use the repository generator:

   ```bash
   npm run create:listener -- <name> <event>
   ```

   The generator is implemented in [`scripts/create-listener.ts`](../../../scripts/create-listener.ts). It validates the event against Discord.js, derives the event argument tuple from the installed `ClientEvents` types, creates `src/listeners/handlers/<name>.listener.ts`, and wires the class into `src/listeners/listeners.module.ts`.

3. Inspect the generated file and replace its TODO. The generator emits `@On(Events.<Event>)`; change it to `@Once(Events.<Event>)` when the behavior must only happen once.
4. Keep the generated event parameter list and `ContextOf` type synchronized. For events with multiple arguments, destructure all arguments in the same order as the `ClientEvents` tuple.
5. Before relying on an event, confirm the required gateway intent is enabled in [`src/bot/bot.module.ts`](../../../src/bot/bot.module.ts). Privileged intents also need to be enabled in the Discord application settings. The current bot explicitly enables `Guilds` and `GuildMembers`.
6. Inject Nest services through the listener constructor. Use Nest’s `Logger` for operational failures and avoid blocking event callbacks with unnecessary work; defer or queue long-running external work when appropriate.
7. Avoid duplicate registrations. A listener class should be registered once in `listeners.module.ts`, and the event should not also be subscribed manually with `client.on()`.

## Canonical listener shape

```ts
import { Injectable } from "@nestjs/common";
import { Events } from "discord.js";
import { Context, type ContextOf, On } from "necord";

@Injectable()
export class ExampleListener {
  @On(Events.GuildMemberAdd)
  async handleGuildMemberAdd(@Context() [member]: ContextOf<Events.GuildMemberAdd>) {
    // Implement the event behavior here.
  }
}
```

For a one-time lifecycle handler:

```ts
import { Client, Events } from "discord.js";
import { Context, Once } from "necord";

@Once(Events.ClientReady)
async onClientReady(@Context() [client]: [Client]) {
  // Runs once when the Discord client becomes ready.
}
```

When not using the generator, add the class import and class name to `HANDLERS` in `src/listeners/listeners.module.ts`.

## Verification

- Search `src` for the event name and listener class to confirm there is one intended registration and no stale TODO.
- Run `npm run lint` and `npm run build` when dependencies are installed.
- Run `git diff --check` and inspect the diff for unintended changes.
- Report inability to run checks, such as missing `node_modules`, rather than claiming the listener was compiled or tested.

For the project layout rationale, consult [`guides/PROJECT_STRUCTURE.md`](../../../docs/guides/PROJECT_STRUCTURE.md). For generator behavior, consult [`scripts/create-listener.ts`](../../../scripts/create-listener.ts).
