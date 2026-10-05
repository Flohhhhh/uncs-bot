# Automatic Discord roles (UNC, Founder and Supporter)

Gramps can keep three community roles in step with its own records:

- **UNC**: added when a website whitelist application with relationship `unc_member` reaches `approved`. That covers a real whitelist grant and a staff-confirmed registration of an entry that was already whitelisted. `friend_regular` and `new_player` applications never receive it automatically.
- **Founder**: added for every founder record (Patreon or PayPal), recorded by staff or [automatically](PATREON_SUPPORTERS.md#automatic-founder-promises), whose supporter has a linked Discord account, whether staff linked it, it was entered on the PayPal record, or the Patreon import filled it in from the patron's connected Discord account. It is never removed automatically.
- **Supporter**: added for people with a linked Discord account who support The UNCs right now, and removed when that support ends. This is how people who support after the founder window closes are recognised. See [The Supporter role](#the-supporter-role). It is optional: with `DISCORD_SUPPORTER_ROLE_ID` unset it is skipped entirely.

The feature is **off by default** (`DISCORD_ROLES_ENABLED=false`). While it is off, the status page and the dry-run preview still work, so the setup can be checked before anything changes in Discord.

## Rules

Manual changes in Discord always win:

- A role that someone already has is only **noted** in the role ledger. Gramps never counts it as a role it added, so it never removes it.
- If staff remove a role that Gramps added, Gramps does not add it back during that person's current membership. The status page lists it under **Needs attention** as `removed_in_discord`.
- Gramps records that removal once as a note in the role ledger, as it does when a role it added is already gone by the time its reason ends. A role staff give back by hand afterwards therefore counts as theirs and is never removed automatically.
- When someone leaves and rejoins the server, earlier history no longer applies and their earned roles are added again.

Gramps removes a role in exactly two cases. The **UNC** role, when **all** of these hold:

1. Gramps revoked or removed that application's whitelist access (the application is `revoked`), and
2. the role ledger shows Gramps itself added the role during the person's current membership, and
3. no other approved `unc_member` application remains for that person on any server.

The **Supporter** role, when the person no longer supports (see below) and the role ledger shows Gramps itself added the role during their current membership. The removal row names the supporter record Gramps used when it added the role.

The **Founder** role is never removed automatically. A founder who still supports holds both Founder and Supporter; a founder who stops supporting keeps Founder and loses Supporter.

Ledger history is kept per Discord role ID. If `DISCORD_MEMBER_ROLE_ID`, `DISCORD_FOUNDER_ROLE_ID` or `DISCORD_SUPPORTER_ROLE_ID` changes (the role was recreated, or a wrong ID was corrected), history recorded for the old role does not count for the new one: earned roles are added, and a new role someone already holds is only noted.

## The Supporter role

The Supporter role is a Discord role only. It changes nothing in game: no whitelist access, no queue priority and no other reward. Founder promises are separate and unchanged.

A person holds it while at least one supporter record with their Discord account linked counts as supporting:

- **Patreon:** Patreon reports them as an active patron (`active_patron`), the latest charge was not refunded, fraudulent or otherwise reversed (Patreon's `Refunded`, `Partially Refunded`, `Refunded by Patreon`, `Refund Pending`, `Fraud` and `Other`; a `Refund Declined` charge still stands), and at least one completed payment is on record. Patreon charges the tier price itself, so any tier counts in any currency, and no founder minimum is checked again.
- **Declined Patreon charge:** when Patreon reports a declined patron (`declined_patron`), the role stays for 7 days after the declined charge's date, because Patreon retries the card. After that it is removed unless Patreon reports them active again.
- **PayPal:** a staff-recorded PayPal payment that meets the founder minimum keeps the role for 31 days after the payment date. That covers one-time gifts; a later payment starts a new 31 days.

Patreon payments come from the Patreon API import (or a staff receipt), so the import must be configured for Patreon supporters to receive the role. Only records of the configured campaign count (`PATREON_ENABLED=true` and `PATREON_CAMPAIGN_ID`), the same records the supporter dashboard shows. While Patreon is switched off, Patreon records do not count, because their status is no longer kept up to date. A cancelled membership (`former_patron`) or a refund ends support at the next check. Every window ends exclusively: a PayPal payment made at noon on November 1 counts until just before noon on December 2.

Gramps checks the Supporter role whenever a supporter record changes (a Patreon import change or signed webhook, a staff receipt, a Discord link or a new PayPal record). A role whose 7- or 31-day window simply runs out is removed by the next six-hour safety pass.

Nothing is ever approved automatically. Staff can confirm that a Discord member owns a SteamID that is already on the running whitelist; that confirmation is only enforced when `WHITELIST_APPLICATION_EXISTING_CONFIRMATION_REQUIRED=true` (see [Whitelist applications](WHITELIST_APPLICATIONS.md#existing-whitelist-members)).

## Discord setup

1. The **UNC**, **Founder** and **Supporter** roles must be ordinary roles: not `@everyone`, not managed by an integration, and without moderation or administrator permissions (Administrator, Manage Server, Manage Roles, Manage Channels, Ban, Kick, Timeout, Manage Messages, Manage Webhooks, Mention Everyone). Gramps refuses any role that has one of these.
2. None of them may be one of the dashboard staff roles in `ADMIN_ADMIN_ROLE_IDS`, `ADMIN_MODERATOR_ROLE_IDS` or `ADMIN_VIEWER_ROLE_IDS`, because assigning it would grant dashboard access, or the opt-in Seeder role in `SEEDING_ROLE_ID`, which members add to themselves (see [Seeding](SEEDING.md#safety-checks)). Each must also be a different role.
3. The bot's role needs the **Manage Roles** permission and must sit **above** every configured role in Server Settings → Roles. Discord only lets a bot assign roles below its own highest role.
4. The Server Members Intent is already required by the bot (`src/bot/bot.module.ts`) and must stay enabled in the Discord developer portal.
5. To show UNC members, Founders or Supporters as their own groups in the member list, turn on **Display role members separately from online members** for each role and keep those roles above any other displayed role their members also hold (for example "Wardogs"). A member who holds several is listed under the highest. Role icons are optional and need Server Boost level 2.

Copy each role ID with Developer Mode on (right-click the role → **Copy Role ID**). If a role ID is missing or wrong, the status page lists roles named exactly "UNC", "Founder" or "Supporter" as candidates.

## Configuration

| Variable                    | Value                                                                  |
| --------------------------- | ---------------------------------------------------------------------- |
| `DISCORD_ROLES_ENABLED`     | `false` until the dry run looks right, then `true` (restart to apply). |
| `DISCORD_MEMBER_ROLE_ID`    | The UNC role ID.                                                       |
| `DISCORD_FOUNDER_ROLE_ID`   | The Founder role ID.                                                   |
| `DISCORD_SUPPORTER_ROLE_ID` | Optional. The Supporter role ID.                                       |
| `ADMIN_GUILD_ID`            | The community server (already used by staff sign-in).                  |

A role that is not configured is simply skipped. Founder awards also need the founder window; see [Supporter records](PATREON_SUPPORTERS.md#founder-window-settings).

## Staff status and controls

`GET /admin/api/discord-roles` (administrators only) works whether or not the feature is enabled. It returns:

- `enabled`, `configured` (`guild`, `memberRole`, `founderRole` and `supporterRole`), `discordReady`, and `bot: {manageRoles, highestRolePosition}`;
- `roles.member`, `roles.founder` and `roles.supporter`: `{id, name, exists, position, managed, privileged, staffRole, assignable, problem, candidates?}`, where `problem` is a plain-English fix;
- `ready`: every configured role passes its checks;
- `lastPass` (trigger, times, `added`, `removed`, `noted`, `confirmed`, `failed`, `blocked`, `deferred`, `attention`), `lastFullPass` (the same for the last check of everyone: startup, the safety pass or an untargeted staff run), `running`, `queued`, `fullPassQueued` and `nextRetryAt`. An event check that found nothing to do does not replace `lastPass`;
- `summary: {memberEligible, founders, foundersWithoutDiscord, supporterEligible}`, where `memberEligible` counts people (Discord accounts) with an approved UNC member application, not applications, and `supporterEligible` counts people with a linked Discord account who support right now and is `null` while `DISCORD_SUPPORTER_ROLE_ID` is unset;
- `attention`: founders without a linked Discord account, people who are not in the server (except someone whose only reason is the Supporter role: joining the server queues a check that adds it), roles removed in Discord, and failed changes. Items stay listed across checks until that person (and role) is checked again, so a later check of someone else never hides them;
- `recent`: the latest 25 role ledger rows.

`POST /admin/api/discord-roles/reconcile` (administrators only, same-origin CSRF) takes `{id, reason, discordUserId?, dryRun?}`:

- `dryRun: true` returns a plan of `{discordUserId, roleKind, op, why}` entries and changes nothing. It stops taking new people at 100 entries, and plans each person's roles together, so a plan can hold up to 102. A role that fails its setup checks is left out (counted in `blocked`), and so is anyone Discord would not return (counted in `failed`); the page says so instead of reporting that nothing would change. It is allowed while the feature is off.
- A real run needs `DISCORD_ROLES_ENABLED=true`; otherwise it returns 503 "Discord roles are switched off (DISCORD_ROLES_ENABLED=false)".
- It returns 409 while another pass is running, and 409 for a preview while another preview is still reading Discord.
- Real runs and previews are spaced separately. A real run within 30 seconds of the last real run returns 429 "Wait 30 seconds between role checks.", and a preview within 5 seconds of the last preview returns 429 "Wait 5 seconds between previews." A preview never counts toward the 30-second wait, so staff can preview and then run straight away, and a real run never holds up the next preview.
- Repeating the same `id` returns the same result without waiting. A real run waits for the pass to finish (at most about a minute for 50 changes).
- `discordUserId` limits the run to one person.

The dashboard's **Discord roles** page (administrators only) shows each check with its fix, the last checks, the attention list including founders without Discord, recent role changes, and **Preview changes** (dry run) and **Run role check now** buttons. A real run from the page needs the feature switched on, every configured role passing its checks, and a preview from the last 10 minutes.

## When roles are checked

- **Startup:** with the feature on, Gramps waits for Discord to connect and then checks everyone with a reason to hold or lose a role. This is also the **backfill**: the first start after enabling adds the UNC role for every existing approved UNC application, the Founder role for every founder with a linked Discord account and, when configured, the Supporter role for everyone who supports right now.
- **Events:** an approval, recheck or revocation, a founder award (by staff, or recorded automatically), a Discord link on a supporter (by staff, filled in by the Patreon import, or made by the patron with [Link Patreon](PATREON_SUPPORTERS.md#link-patreon-patrons-link-their-own-discord)), a staff receipt, a new PayPal record, a Patreon import that changed a linked supporter's record, a new signed Patreon webhook for a linked supporter, or someone joining the server queues a check for that person (batched for two seconds).
- **Safety pass:** a full check every six hours. It also covers anyone an event check missed, Supporter roles whose 7- or 31-day window ran out, and a Supporter role left on an account after staff moved a supporter record's Discord link to another account.
- **Staff:** the reconcile endpoint above.

Each pass makes at most 50 role changes, waits 1.1 seconds between changes and leaves the rest for a follow-up a minute later (staff runs included). discord.js also honours Discord's rate limits and retries server errors three times. A single Gramps instance is assumed.

## The role ledger and failures

Every add, remove and note is a `discord_role_actions` row by `system:discord-roles` ("Gramps Discord roles"), written **before** Discord is contacted and completed afterwards. Rows record the trigger, the requesting staff member for admin runs, the guild, member, role (`role_kind` `member`, `founder` or `supporter`), operation, the application or supporter record that justified it (`basis_type` `application`, `founder` or `supporter`), whether anything changed, and the result. Both are plain text columns, so the Supporter role needs no migration of its own. Role changes are kept out of the per-server game action history on purpose because they are not tied to one game server. Discord's audit log shows a fixed reason with no private data: "Gramps: UNC member application approved", "Gramps: UNC application revoked", "Gramps: founding supporter", "Gramps: active supporter" or "Gramps: support ended".

| Discord result                                      | Effect                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing permissions (50013) or unknown role (10011) | Row `failed`. That role is skipped for the rest of the pass and one warning is logged.                                                                                                                                                                                                                                                                                                    |
| Member left during the pass (10007)                 | Row `failed`.                                                                                                                                                                                                                                                                                                                                                                             |
| Server error, timeout or network error              | Row `unknown`. The person is retried after 1 minute, then 5 minutes, 30 minutes, 2 hours and every 6 hours. If an unknown add turns out to be present, or an unknown UNC or Supporter removal turns out to be gone, the row is confirmed instead of repeating the change. A removal is repeated while the role is still present. A `started` row left by a crash is treated the same way. |

Gramps logs a warning only for blocked or failed passes, with fixed text: database and Discord error messages can carry member IDs or query parameters, so they are never logged. It never logs each change and never logs the Discord event again (the event interceptor already does).

## Recording PayPal supporters and founders

Record each PayPal donor with **Record PayPal supporter** (`POST /admin/api/supporters/paypal`, see [Supporter records](PATREON_SUPPORTERS.md#recording-paypal-supporters)). Include their Discord user ID so the Founder and Supporter roles can be added; a founder without one appears under **Needs attention** as `founder_without_discord` until staff link the account. Patreon founders are awarded by staff after the Patreon import has recorded their payment history, or recorded automatically when `SUPPORTER_AUTO_FOUNDER_ENABLED` is on (see [Automatic matching](PATREON_SUPPORTERS.md#automatic-matching)).

## Rollout

1. A human contributor generates and reviews one migration for the combined schema changes (this branch and the Patreon import), then deploys. Railway's pre-deploy step runs `db:migrate`.
2. Set the founder window and the role IDs in Railway (`DISCORD_SUPPORTER_ROLE_ID` is optional), leaving `DISCORD_ROLES_ENABLED=false`.
3. Fix the bot's permission and role position until the status endpoint reports `ready: true`.
4. Record the PayPal donors with `awardFounder`, and award the Patreon founders after the import, from the Supporters page, where each record Gramps would make a founder shows "Ready to be made a founder." under **Needs you**. Turn on `SUPPORTER_AUTO_FOUNDER_ENABLED` only once staff can void a founder promise; until then award by hand.
5. Review a dry run, then set `DISCORD_ROLES_ENABLED=true` and restart. The startup pass performs the backfill.

## Not included

- A declined or mistyped application still blocks a new application on that server (per-server unique indexes). A partial index excluding `declined`, or a staff reopen action, would fix it.
- Reinstating a revoked application.
- Marking a PayPal payment refunded or charged back. A recorded PayPal payment keeps the Supporter role for its 31 days; staff can remove the role by hand in Discord, and Gramps does not add it back during that membership.
- Founder whitelist grants remain manual.
