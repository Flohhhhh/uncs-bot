# Seeding pings and the Seeder role

When the WARDOGS server is quiet, a few early risers can get a match going. Members who want to help opt in to a **Seeder** role, and staff ping that role by hand when the server needs players. It is off by default.

- **Opt-in only.** Members add or remove the role on themselves with `/seeding join` and `/seeding leave`, or with the **I'll help seed** and **Stop pinging me** buttons on a panel staff post.
- **No automatic pings, ever.** Nothing runs on a timer or reacts to the player count. A ping goes out only when a staff member runs `/seeding ping`.
- **Nothing else changes.** Gramps only adds or removes the Seeder role on the member who asked. It never kicks, bans, whitelists or grants anything, and seeding comes with no rewards, points or whitelist access. Keep any copy you write for it the same way.
- **No database.** The role is the list of who opted in. There is no schema change and no migration.

## Commands

All replies are private (ephemeral).

| Command                | Who        | What it does                                                                      |
| ---------------------- | ---------- | --------------------------------------------------------------------------------- |
| `/seeding join`        | Any member | Adds the Seeder role to you.                                                      |
| `/seeding leave`       | Any member | Removes the Seeder role from you.                                                 |
| `/seeding panel`       | Staff      | Posts the opt-in panel with the two buttons in the channel you run it in.         |
| `/seeding ping [note]` | Staff      | Posts one call to the Seeder role in the ping channel. Subject to the cooldown.   |
| `/seeding status`      | Staff      | Shows whether seeding is configured, how many Seeders there are and the cooldown. |

**Staff** means the same Discord identities as the staff dashboard's admin and moderator access: a user in `ADMIN_OWNER_IDS`, or a member with a role in `ADMIN_ADMIN_ROLE_IDS` or `ADMIN_MODERATOR_ROLE_IDS`. Members with Discord's **Manage Roles** permission also count. A viewer role alone does not. These settings work without `ADMIN_ENABLED`. Discord lists every subcommand for everyone, because one command can't hide only some of its subcommands; Gramps checks staff access when a staff subcommand runs.

Everything works only inside the `ADMIN_GUILD_ID` server. Elsewhere, Gramps says so and does nothing.

## Setup

1. **Create the role.** Server Settings → Roles → **Create Role**, named `Seeder` (any name works). Clear every permission: Gramps refuses to hand out a role with moderation or management permissions (see [Safety checks](#safety-checks)). Leave **Allow anyone to @mention this role** off, so only staff pings reach it. **Display role members separately** is up to you.
2. **Place it below Gramps.** In the role list, drag `Seeder` below Gramps' own role, and make sure Gramps has **Manage Roles**. Discord only lets a bot assign roles below its highest role; otherwise every join fails with Missing Permissions (50013).
3. **Pick the ping channel.** A text or announcement channel in the same server. Gramps needs **View Channel** and **Send Messages** there, and **Mention @everyone, @here and All Roles** so the Seeder mention actually notifies people. A channel permission override for Gramps is enough. The ping's allowed mentions are restricted to the Seeder role, so that permission can't be used to ping anyone else.
4. **Copy the IDs.** With Discord's Developer Mode on (User Settings → Advanced), right-click the role → **Copy Role ID**, and the channel → **Copy Channel ID**.
5. **Set the variables** below and redeploy. `ADMIN_GUILD_ID` must already be set to this server.
6. **Check it.** Run `/seeding status`. It should say `Configured: yes, ready to ping.` Otherwise each line says what to fix.
7. **Post the panel.** In the channel where members should find it (for example a roles or info channel), run `/seeding panel`. Gramps needs View Channel and Send Messages there. The buttons keep working across restarts and deploys, because their IDs are fixed (`uncs-seeding/join` and `uncs-seeding/leave`). Running it again posts another panel; delete old ones by hand.

## Configuration

| Setting                         | Default | Notes                                                                                  |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `SEEDING_ENABLED`               | `false` | Turns on join, leave, the buttons, panel and ping. `/seeding status` works either way. |
| `SEEDING_ROLE_ID`               | none    | The Seeder role in `ADMIN_GUILD_ID`.                                                   |
| `SEEDING_PING_CHANNEL_ID`       | none    | Text or announcement channel in `ADMIN_GUILD_ID` for `/seeding ping`.                  |
| `SEEDING_PING_COOLDOWN_MINUTES` | `120`   | Minimum minutes between pings, 15–1440, per Discord server.                            |

While `SEEDING_ENABLED=false`, members are told sign-ups are switched off, and panel and ping tell staff to turn it on first. Existing Seeders keep the role; nobody is pinged.

## What a ping looks like

```
@Seeder **Seeders, it's go time.** The WARDOGS server is quieter than an early-bird dinner at 3:45. Come help get a match going.
Players on right now: **3/64**
Join by ID: `00000000-0000-4000-8000-000000000001` (the **Join by ID** button is bottom-left in the server browser)
Staff note: Map night at 8, bring a friend
-# You get these because you joined the Seeder role. `/seeding leave` turns them off.
```

- **Player count:** read through the existing cached game overview (`GameServers` → `WardogsClient.overview()`, cached for 5 seconds) for the primary server: the single configured server, or the `primary` entry of `WARDOGS_SERVERS` (else its first entry). If the game can't be read within 10 seconds, or no game connection is configured, the line is left out and the ping still goes.
- **How to join:** that server's public join code (`WARDOGS_SERVER_JOIN_ID`, or the registry entry's `joinId`). Without one, the ping links https://theuncsgaming.com instead.
- **Staff note:** optional, at most 200 characters, one line. Gramps folds line breaks and control characters into spaces, strips invisible formatting characters, removes user and role mentions, and turns `@everyone` and `@here` into plain words.
- **Mentions:** `allowedMentions` is `{ roles: [SEEDING_ROLE_ID] }` and nothing else, so only the Seeder role is notified. Link previews are suppressed.

## Cooldown and sending once

- The cooldown is per Discord server and kept in memory. A restart or deploy resets it, which is acceptable for a hand-sent ping.
- A refused ping tells staff how long is left, for example `The next seeding ping opens in 1 h 12 min.` Minutes are rounded up.
- The cooldown is claimed the moment a ping starts, before Gramps reads the role, channel or game, so two staff members pinging at once send one message.
- It is given back only when nothing was posted: a setup problem found before sending, or Discord definitely refusing the send (a 4xx answer such as 50013 Missing Permissions).
- **Uncertain sends are never retried.** If Discord doesn't confirm the send (a timeout or network error), Gramps keeps the cooldown, asks staff to check the channel, and does not resend. The send carries a nonce with `enforceNonce`, so Discord drops a duplicate if the request itself is replayed.

## Safety checks

Gramps refuses to add or remove the configured role, and won't post the panel, when the role is:

- `@everyone`, or a managed role (a bot or integration role);
- one of the staff roles in `ADMIN_ADMIN_ROLE_IDS`, `ADMIN_MODERATOR_ROLE_IDS` or `ADMIN_VIEWER_ROLE_IDS`;
- a role with any of: Administrator, Manage Server, Manage Roles, Manage Channels, Manage Webhooks, Manage Messages, Manage Threads, Manage Nicknames, Manage Events, Manage Expressions, Kick Members, Ban Members, Timeout Members, Mute Members, Deafen Members, Move Members, Mention @everyone, @here and All Roles, or View Audit Log.

A ping is refused for such a role too. A ping does not need Gramps to be able to assign the role, so it still works while the role sits above Gramps; joining and leaving don't.

`/seeding status` warns when **Allow anyone to @mention this role** is on, because then any member can ping the Seeders, not just staff.

## Troubleshooting

| Reply                                                 | Fix                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| "Seeding sign-ups are switched off right now"         | Set `SEEDING_ENABLED=true`.                                                                     |
| "Seeding isn't set up yet"                            | Set `ADMIN_GUILD_ID` and `SEEDING_ROLE_ID`.                                                     |
| "This only works inside The UNCs Discord"             | Run it in the `ADMIN_GUILD_ID` server.                                                          |
| "The Seeder role has wandered off"                    | The role was deleted or `SEEDING_ROLE_ID` is wrong. Copy the role ID again.                     |
| "Gramps can't reach the Seeder role on the top shelf" | Drag the Seeder role below Gramps and give Gramps Manage Roles (Discord error 50013).           |
| "The Seeder role isn't set up right"                  | The role failed a [safety check](#safety-checks). Use a plain role with no permissions.         |
| "Gramps can't mention Seeder in the ping channel"     | Give Gramps Mention @everyone, @here and All Roles in that channel.                             |
| "Gramps can't post in the ping channel"               | Use a text or announcement channel where Gramps has View Channel and Send Messages.             |
| "Gramps can't post the panel here"                    | Run `/seeding panel` in a text or announcement channel where Gramps can view and send messages. |
| "Discord didn't confirm the ping"                     | Check the ping channel. If the call isn't there, ping again once the cooldown ends.             |
