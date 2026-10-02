# Automatic Discord roles (UNC and Founder)

Gramps can keep two community roles in step with its own records:

- **UNC**: added when a website whitelist application with relationship `unc_member` reaches `approved`. That covers a real whitelist grant and a staff-confirmed registration of an entry that was already whitelisted. `friend_regular` and `new_player` applications never receive it automatically.
- **Founder**: added for every founder record (Patreon or PayPal) whose supporter has a linked Discord account. It is never removed automatically.

The feature is **off by default** (`DISCORD_ROLES_ENABLED=false`). While it is off, the status page and the dry-run preview still work, so the setup can be checked before anything changes in Discord.

## Rules

Manual changes in Discord always win:

- A role that someone already has is only **noted** in the role ledger. Gramps never counts it as a role it added, so it never removes it.
- If staff remove a role that Gramps added, Gramps does not add it back during that person's current membership. The status page lists it under **Needs attention** as `removed_in_discord`.
- When someone leaves and rejoins the server, earlier history no longer applies and their earned roles are added again.

Gramps removes a role in exactly one case: the **UNC** role, when **all** of these hold:

1. Gramps revoked or removed that application's whitelist access (the application is `revoked`), and
2. the role ledger shows Gramps itself added the role during the person's current membership, and
3. no other approved `unc_member` application remains for that person on any server.

Ledger history is kept per Discord role ID. If `DISCORD_MEMBER_ROLE_ID` or `DISCORD_FOUNDER_ROLE_ID` changes (the role was recreated, or a wrong ID was corrected), history recorded for the old role does not count for the new one: earned roles are added, and a new role someone already holds is only noted.

Nothing is ever approved automatically. Staff can confirm that a Discord member owns a SteamID that is already on the running whitelist; that confirmation is only enforced when `WHITELIST_APPLICATION_EXISTING_CONFIRMATION_REQUIRED=true` (see [Whitelist applications](WHITELIST_APPLICATIONS.md#existing-whitelist-members)).

## Discord setup

1. The **UNC** and **Founder** roles must be ordinary roles: not `@everyone`, not managed by an integration, and without moderation or administrator permissions (Administrator, Manage Server, Manage Roles, Manage Channels, Ban, Kick, Timeout, Manage Messages, Manage Webhooks, Mention Everyone). Gramps refuses any role that has one of these.
2. Neither role may be one of the dashboard staff roles in `ADMIN_ADMIN_ROLE_IDS`, `ADMIN_MODERATOR_ROLE_IDS` or `ADMIN_VIEWER_ROLE_IDS`, because assigning it would grant dashboard access. The two roles must also be different roles.
3. The bot's role needs the **Manage Roles** permission and must sit **above** both roles in Server Settings → Roles. Discord only lets a bot assign roles below its own highest role.
4. The Server Members Intent is already required by the bot (`src/bot/bot.module.ts`) and must stay enabled in the Discord developer portal.
5. To show UNC members and Founders as their own groups in the member list, turn on **Display role members separately from online members** for each role and keep both roles above any other displayed role their members also hold (for example "Wardogs"). A member who holds both is listed under the higher of the two. Role icons are optional and need Server Boost level 2.

Copy each role ID with Developer Mode on (right-click the role → **Copy Role ID**). If a role ID is missing or wrong, the status page lists roles named exactly "UNC" or "Founder" as candidates.

## Configuration

| Variable                  | Value                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| `DISCORD_ROLES_ENABLED`   | `false` until the dry run looks right, then `true` (restart to apply). |
| `DISCORD_MEMBER_ROLE_ID`  | The UNC role ID.                                                       |
| `DISCORD_FOUNDER_ROLE_ID` | The Founder role ID.                                                   |
| `ADMIN_GUILD_ID`          | The community server (already used by staff sign-in).                  |

A role that is not configured is simply skipped. Founder awards also need the founder window; see [Supporter records](PATREON_SUPPORTERS.md#founder-window-settings).

## Staff status and controls

`GET /admin/api/discord-roles` (administrators only) works whether or not the feature is enabled. It returns:

- `enabled`, `configured` (guild and both role IDs), `discordReady`, and `bot: {manageRoles, highestRolePosition}`;
- `roles.member` and `roles.founder`: `{id, name, exists, position, managed, privileged, staffRole, assignable, problem, candidates?}`, where `problem` is a plain-English fix;
- `ready`: every configured role passes its checks;
- `lastPass` (trigger, times, `added`, `removed`, `noted`, `confirmed`, `failed`, `blocked`, `deferred`, `attention`), `lastFullPass` (the same for the last check of everyone: startup, the safety pass or an untargeted staff run), `running`, `queued`, `fullPassQueued` and `nextRetryAt`. An event check that found nothing to do does not replace `lastPass`;
- `summary: {memberEligible, founders, foundersWithoutDiscord}`;
- `attention`: founders without a linked Discord account, people who are not in the server, roles removed in Discord, and failed changes. Items stay listed across checks until that person (and role) is checked again, so a later check of someone else never hides them;
- `recent`: the latest 25 role ledger rows.

`POST /admin/api/discord-roles/reconcile` (administrators only, same-origin CSRF) takes `{id, reason, discordUserId?, dryRun?}`:

- `dryRun: true` returns a plan of at most 100 `{discordUserId, roleKind, op, why}` entries and changes nothing. It is allowed while the feature is off.
- A real run needs `DISCORD_ROLES_ENABLED=true`; otherwise it returns 503 "Discord roles are switched off (DISCORD_ROLES_ENABLED=false)".
- It returns 409 while another pass is running and 429 when called again within 30 seconds. Repeating the same `id` returns the same result. A real run waits for the pass to finish (at most about a minute for 50 changes).
- `discordUserId` limits the run to one person.

The dashboard redesign owns the page itself. The intended panel shows each check with its fix, the last pass, the attention list including founders without Discord, recent actions, and **Preview** (dry run) and **Run role check now** buttons.

## When roles are checked

- **Startup:** with the feature on, Gramps waits for Discord to connect and then checks everyone with a reason to hold or lose a role. This is also the **backfill**: the first start after enabling adds the UNC role for every existing approved UNC application and the Founder role for every founder with a linked Discord account.
- **Events:** an approval, recheck or revocation, a founder award, a Discord link on a supporter, a new PayPal record, or someone joining the server queues a check for that person (batched for two seconds).
- **Safety pass:** a full check every six hours. It also picks up Discord IDs filled in later, for example by the Patreon import.
- **Staff:** the reconcile endpoint above.

Each pass makes at most 50 role changes, waits 1.1 seconds between changes and leaves the rest for a follow-up a minute later (staff runs included). discord.js also honours Discord's rate limits and retries server errors three times. A single Gramps instance is assumed.

## The role ledger and failures

Every add, remove and note is a `discord_role_actions` row by `system:discord-roles` ("Gramps Discord roles"), written **before** Discord is contacted and completed afterwards. Rows record the trigger, the requesting staff member for admin runs, the guild, member, role, operation, the application or supporter record that justified it, whether anything changed, and the result. Role changes are kept out of the per-server game action history on purpose because they are not tied to one game server. Discord's audit log shows a fixed reason such as "Gramps: UNC member application approved" with no private data.

| Discord result                                      | Effect                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing permissions (50013) or unknown role (10011) | Row `failed`. That role is skipped for the rest of the pass and one warning is logged.                                                                                                                                                                                                                                                                                       |
| Member left during the pass (10007)                 | Row `failed`.                                                                                                                                                                                                                                                                                                                                                                |
| Server error, timeout or network error              | Row `unknown`. The person is retried after 1 minute, then 5 minutes, 30 minutes, 2 hours and every 6 hours. If an unknown add turns out to be present, or an unknown UNC removal turns out to be gone, the row is confirmed instead of repeating the change. A removal is repeated while the role is still present. A `started` row left by a crash is treated the same way. |

Gramps logs a warning only for blocked or failed passes, with fixed text: database and Discord error messages can carry member IDs or query parameters, so they are never logged. It never logs each change and never logs the Discord event again (the event interceptor already does).

## Recording PayPal supporters and founders

Record each PayPal donor with **Record PayPal supporter** (`POST /admin/api/supporters/paypal`, see [Supporter records](PATREON_SUPPORTERS.md#recording-paypal-supporters)). Include their Discord user ID so the Founder role can be added; a founder without one appears under **Needs attention** as `founder_without_discord` until staff link the account. Patreon founders are awarded after the Patreon import has recorded their payment history.

## Rollout

1. A human contributor generates and reviews one migration for the combined schema changes (this branch and the Patreon import), then deploys. Railway's pre-deploy step runs `db:migrate`.
2. Set the founder window and both role IDs in Railway, leaving `DISCORD_ROLES_ENABLED=false`.
3. Fix the bot's permission and role position until the status endpoint reports `ready: true`.
4. Record the PayPal donors with `awardFounder`, and award the Patreon founder after the import.
5. Review a dry run, then set `DISCORD_ROLES_ENABLED=true` and restart. The startup pass performs the backfill.

## Not included

- A declined or mistyped application still blocks a new application on that server (per-server unique indexes). A partial index excluding `declined`, or a staff reopen action, would fix it.
- Reinstating a revoked application.
- Founder whitelist grants remain manual.
