# Gramps server community messages

These optional workers provide welcome whispers, round-transition broadcasts and edits to an existing Discord status message per configured server. Run one community-worker instance per deployment; its in-memory queue is not a cross-process delivery claim. All switches default to `false`. Deployment alone does not activate them or change game configuration or feed destinations.

## Multiple servers

Omit `WARDOGS_SERVERS` to retain the original `primary` connection. To expand, configure its JSON array with permanent `id`, public `name`, private `rconUrl` and `password` entries. Preserve the original server as `primary`; never reuse an ID for a different game. A registry requires explicit staff selection and rejects legacy unscoped game routes. Optional per-server `staffRoles` narrow community permissions: absent lists inherit the community role, empty lists deny non-owners, and no list can promote a community viewer or moderator. Configured owners retain administrator access.

Welcomes and round messages share wording and feature flags, but each server has its own baseline, bounded queue, timer and backoff. Configure a distinct `communityStatus` object with `channelId` and bot-owned `messageId` for each desired card. Registry mode never copies the legacy shared message to every server; absent IDs mean no card output. Destinations must belong to `ADMIN_GUILD_ID`.

Each server may have a unique `feedToken`, separate from every game password. Deliver to `/api/ingest/servers/ID/events`. The receiver derives the stable identity from that authenticated route, never the payload's per-boot UUID or display name. Public labels use `/community/api/servers`; rankings use `/community/api/servers/ID/leaderboard`. Staff routes use `/admin/api/servers/ID/...` with ordinary session/role checks; mutations also require the endpoint version from the staff server list. Registry credentials never belong in website files.

The [release audit](ADMIN_RELEASE_AUDIT.md) records the current deployed state and earlier migration/cutover evidence. Applications, combat and website selectors use the server-aware schema. An application approval is scoped to its server; supporter status grants no game access. A new deployment must apply the checked-in migrations before use. No additional live server has been configured.

## Host restart schedules

[xREALM's general scheduler](https://xrealm.com/en/blog/how-to-add-schedules-to-your-server) separates a schedule's timing from its tasks. In the selected server's host panel, review existing schedules, create the desired cadence, then add a task. Confirm the displayed timezone and next-run timestamp; the public guide alone does not establish the current server's schedule.

Read-only inspection on October 2 found schedule **Restarts** (`16302`) marked Active with cron `0 3 * * *`, displayed as **daily at 23:00 (UTC-4)**. Its detail page contains **no tasks**, says **Last run at: never**, and shows a stale **Next run at: Sep 30th at 11:00PM**. This does not establish a working restart or after-match routine. No schedule, task, setting or server power state was changed.

The separate **Settings → Wardogs Daily Restart Time** field is blank. Its help says blank keeps the current config value and **does not turn off restarts**; the actual configured time therefore remains unknown. The panel takes local 24-hour time, stores UTC, and applies a change on the next server start. Its saved UTC time stays fixed through daylight-saving changes, so maintaining the same local hour requires adjustment. Do not infer a disabled restart, a particular time, or match-end behavior from the blank input, and reconcile these two mechanisms before configuring either.

For WARDOGS, select **[Wardogs] Restart after match-ending**, as documented in [xREALM's dedicated guide](https://www.xrealm.com/en/blog/wardogs-server-restart-after-match-end). Enable the schedule and online-only option. The scheduled time begins waiting; the restart follows at map loading. Configure initial/near-end announcements and a leading-score threshold (documented default: 90 points). Leave the task offset at zero unless intentional. Ordinary power-restart tasks can interrupt play; review them before adding another schedule.

The provider documents an early restart below 20 players with all scores zero, after at least a minute and another check. It waits 90 seconds after detecting shutdown before starting again. Its English guide also describes a separate game uptime restart. These are provider claims, not verified UNCs behavior. Verify build-specific timing, recovery and announcement visibility with the owner. Gramps has no verified scheduler API; its round restart is a different action.

## Configuration

The worker uses the existing `WardogsClient` and requires RCON connection settings. Its own flags control activation; it does not require staff OAuth or `ADMIN_ENABLED`. The Discord card additionally requires `ADMIN_GUILD_ID` and the configured bot-owned message. The `admin_actions` table was deployed and checked through the combined production launch migration on September 30; see [Database prerequisite](ADMIN_DASHBOARD.md#database-prerequisite--launch-migration-applied). UNCs welcome and round messages are configured; accepted, spaced welcome requests were observed on October 2. Round delivery and in-game popup presentation remain unverified. Other deployments still need the reviewed schema. This module adds no database tables or migrations.

| Variable                                        | Default / purpose                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `SERVER_COMMUNITY_ENABLED`                      | `false`; master switch                                               |
| `SERVER_COMMUNITY_WELCOME_ENABLED`              | `false`; whisper to observed new connections                         |
| `SERVER_COMMUNITY_ROUND_ENABLED`                | `false`; generic message at an inferred round transition             |
| `SERVER_COMMUNITY_DISCORD_STATUS_ENABLED`       | `false`; edit the configured existing Discord message                |
| `SERVER_COMMUNITY_WELCOME_MESSAGE`              | `Welcome to The UNCs! Squad up and enjoy the server.`                |
| `SERVER_COMMUNITY_WELCOME_MESSAGES`             | Optional JSON array of 1–4 messages; replaces the single message     |
| `SERVER_COMMUNITY_WELCOME_VARIANTS`             | Optional JSON array of 1–20 sequences; one is picked per join        |
| `SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS` | Optional; same shape, for joiners on that server's running whitelist |
| `SERVER_COMMUNITY_WELCOME_DELAY_SECONDS`        | `10`; first-message loading delay, 0–60 seconds                      |
| `SERVER_COMMUNITY_WELCOME_SPACING_SECONDS`      | `20`; minimum time after a confirmed send, 10–120 seconds            |
| `SERVER_COMMUNITY_ROUND_MESSAGE`                | `GG! Thanks for playing on The UNCs. See you next round.`            |
| `SERVER_COMMUNITY_ROUND_MESSAGES`               | Optional JSON array of 1–20 messages; one is picked per round        |
| `SERVER_COMMUNITY_DISCORD_CHANNEL_ID`           | Existing Discord channel in `ADMIN_GUILD_ID`                         |
| `SERVER_COMMUNITY_DISCORD_MESSAGE_ID`           | Existing message authored by this Gramps bot                         |

Messages are literal, single-line text, 1–200 characters. There is no placeholder expansion or silent truncation. Invalid deployment values fail startup validation; the send boundary also refuses invalid text. When the optional array is absent, the existing single-message setting still works with the configured initial delay. Each feature is independent; status requires both message/channel IDs. Settings are deployment configuration, not editable dashboard controls.

Precedence: `SERVER_COMMUNITY_WELCOME_VARIANTS` replaces `SERVER_COMMUNITY_WELCOME_MESSAGES`, which replaces `SERVER_COMMUNITY_WELCOME_MESSAGE`; `SERVER_COMMUNITY_ROUND_MESSAGES` replaces `SERVER_COMMUNITY_ROUND_MESSAGE`. A replaced setting is ignored while the newer one is set, but it is still validated at startup. With neither new variable set, behavior is unchanged. `SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS` replaces none of these: it applies only to whitelisted joiners, and everyone else keeps the welcome chosen by this precedence (see [Welcomes for whitelisted players](#welcomes-for-whitelisted-players)).

### Varied welcomes and round messages

`SERVER_COMMUNITY_WELCOME_VARIANTS` is a JSON array of 1–20 variants; each variant is itself a JSON array of 1–4 messages, exactly like `SERVER_COMMUNITY_WELCOME_MESSAGES`. Each observed join picks one variant at random and sends that variant's whole sequence with the same loading delay, spacing, expiry, cancellation, audit reason and receipt handling as a single sequence. With two or more variants, a player never gets the variant they got last time; with three or more, a joiner also never gets the variant the previous joiner on that server got.

`SERVER_COMMUNITY_ROUND_MESSAGES` is a JSON array of 1–20 single messages. Each inferred round transition picks one at random, never the one picked for that server's previous round.

A choice is recorded when the welcome or round notice is queued, so a welcome that is later skipped or not confirmed still counts as that player's last variant. Rotation history is in memory and per server. It remembers the 2,048 most recently welcomed players and is lost on restart, so a player can see a repeat after a restart, after a long absence from a busy server, or on another server. Duplicate variants or round messages are rejected, as are values longer than 32,768 characters (variants) or 8,192 characters (round messages); twenty full-length entries fit within those limits.

The staff status endpoint keeps `welcome.messages` (the first variant) and `round.message` (the first round message) for the current dashboard, and adds `welcome.variants` and `round.messages` listing every configured entry. The dashboard does not read the new fields yet: with variants set, it shows only the first variant as the welcome sequence and the first round message as the round message, with no sign of rotation. Until it does, confirm the configured entries in the status response itself while signed in as staff: `/admin/api/servers/ID/community-messages`, fields `welcome.variants` and `round.messages`.

### Welcomes for whitelisted players

`SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS` takes the same JSON shape and limits as `SERVER_COMMUNITY_WELCOME_VARIANTS`: 1–20 variants of 1–4 single-line messages, at most 32,768 characters, no duplicates. When it is set, an observed joiner whose SteamID64 is on that server's running whitelist gets one of these variants instead, with the same delay, spacing, expiry, cancellation and audit handling. Everyone else gets the ordinary welcome chosen by the precedence above. When it is unset, Gramps never reads the whitelist and welcomes behave exactly as before.

Membership comes from the game's running whitelist (`GET /v1/reserved-slots`, the list the dashboard's whitelist page shows as running), not the saved configuration, so an entry that is saved but not yet active counts as not whitelisted. Each server reads its own list. Gramps reads it only in an observation that finds new joiners, and reuses one read for five minutes per server. A whitelist change or configuration save made through Gramps, including an application approval, discards that copy, so a player approved in Gramps gets the whitelisted welcome on their next join once the running whitelist shows them. A change made elsewhere, such as in the host panel or the official RCON console, can take up to five minutes to apply.

If the read fails for any reason (game unreachable, an RCON pause, an unreadable response), that observation's joiners get the ordinary welcome, Gramps logs one warning, and it does not read again for a minute; joiners in that minute also get the ordinary welcome. A read can add up to the client's eight-second request timeout to the observation that makes it.

Each pool has its own rotation history: the no-repeat rules above apply within the whitelisted variants and within the ordinary ones separately, and each pool remembers up to 2,048 players. A player who moves between pools, by being whitelisted or removed, can get any variant of the other pool. Round messages are broadcasts to everyone on the server, so whitelisted players still see any round message that mentions the whitelist.

The staff status response adds `welcome.whitelistedVariants` (null when unset) and `welcome.whitelist`. That object is null when the variable is unset; otherwise it gives `source` (`running-whitelist`), `cacheSeconds` (300), `lastLoadedAt` (when the list behind that server's latest whitelist-aware choice was read) and `lastFailedAt` (that server's latest failed read). Both times are null until the first read after startup. If `lastFailedAt` is later than `lastLoadedAt`, the latest read failed and joiners since then got the ordinary welcome. The dashboard does not show these fields yet.

### Recommended rotating UNCs copy

Dennis supplied rotating copy on October 2. Neither set below is live until both variables are set in the deployment; until then production keeps the sequence and round message described under [Newcomer wording and launch state](#newcomer-wording-and-launch-state). Every line is single-line and under 200 characters.

Five of its welcome variants and one round message tie the whitelist to a shorter queue ("Get queue priority", "Less queue next time", "Tired of queues?", "Less queue, more crew"). Gramps does not provide queue priority. Approving a whitelist entry only adds the player to the game's reserved-slot list (see [Live whitelist behavior](ADMIN_DASHBOARD.md#live-whitelist-behavior)), seeding and queue benefits are not implemented (see the [release audit](ADMIN_RELEASE_AUDIT.md#launch-work-still-requiring-verified-configuration)), and the newcomer guidance below says not to promise queue tiers. The copy therefore comes in two sets that differ only in those lines:

- **Ready-now set.** Neutral whitelist or website lines replace the queue lines. Use this set unless both checks below have passed for that server. The neutral lines were written for this guide, not by Dennis; review them like any other copy.
- **Queue-priority set.** Dennis's original wording, unchanged. Use it on a server only after both checks pass, and switch back to the ready-now set if either stops being true, for example after a reserved-slot change or a game update:
  1. In the dashboard, **Server settings → Joining → Reserved-slot capacity** for that server is greater than 0 and large enough for the whitelisted players expected online at once. At 0 the whitelist reserves no slots.
  2. A whitelisted player has been seen joining that server while it was full with a queue, and getting in ahead of the queue.

Welcome variants (each is a two-message sequence, sent with the usual delay and spacing):

| #   | First message                                                        | Second message, ready-now set                                 | Second message, queue-priority set                              |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | `Welcome to The UNCs. Good games, older knees.`                      | `Get whitelisted: theuncsgaming.com/whitelist`                | `Long queue? Get queue priority at theuncsgaming.com/whitelist` |
| 2   | `Aged a little while you waited? Welcome to The UNCs.`               | `Apply for the whitelist: theuncsgaming.com/whitelist`        | `Less queue next time: theuncsgaming.com/whitelist`             |
| 3   | `You made it. The UNCs salute your patience and your lower back.`    | `Sign in with Discord and apply: theuncsgaming.com/whitelist` | `Tired of queues? theuncsgaming.com/whitelist`                  |
| 4   | `Welcome to The UNCs. Grab a squad, take the hill, mind your knees.` | `Discord and whitelist: theuncsgaming.com`                    | Same                                                            |
| 5   | `Reading glasses on, soldier. The hill will not hold itself.`        | `Welcome to The UNCs: theuncsgaming.com`                      | Same                                                            |
| 6   | `Welcome in. Fast trigger fingers, earned naps.`                     | `Join the crew: theuncsgaming.com/whitelist`                  | `Less queue, more crew: theuncsgaming.com/whitelist`            |
| 7   | `Long queue? We noticed. Welcome to The UNCs.`                       | `Thanks for your patience. Website: theuncsgaming.com`        | `Get queue priority at theuncsgaming.com/whitelist`             |
| 8   | `Welcome to The UNCs. Hydrate, squad up, use comms.`                 | `Find the crew at theuncsgaming.com`                          | Same                                                            |

Round messages:

| #   | Ready-now set                                                                         | Queue-priority set                                       |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | `GG! Get whitelisted at theuncsgaming.com/whitelist. Thanks for playing on The UNCs.` | Same                                                     |
| 2   | `GG, all. Stretch, hydrate, run it back. theuncsgaming.com`                           | Same                                                     |
| 3   | `GG! Good games, older knees. Join the crew: theuncsgaming.com`                       | Same                                                     |
| 4   | `GG! More games, more crew: theuncsgaming.com/whitelist`                              | `GG! Less queue, more crew: theuncsgaming.com/whitelist` |
| 5   | `GG. Thanks for playing on The UNCs. Discord and whitelist: theuncsgaming.com`        | Same                                                     |

Paste the chosen set's exact single-line values into the deployment (Railway takes the raw value, without surrounding quotes). The blocks are plain text so formatters leave each value on one line. The existing `SERVER_COMMUNITY_WELCOME_MESSAGES` and `SERVER_COMMUNITY_ROUND_MESSAGE` values can stay as they are; they are ignored while the new variables are set and take over again if those are removed. Keep the rest of the newcomer guidance (no points, automatic rewards or XP/cash bonuses) for any new copy.

`src/server-community/recommended-copy.spec.ts` checks that these tables, both sets' paste values and the ready-now values in `.env.example` agree, stay on one line and pass startup validation, and that the ready-now set makes no queue promise. Change all three places together. Either set can be combined with the [recommended whitelisted welcome copy](#recommended-whitelisted-welcome-copy); with it set, the whitelist lines above reach only joiners who are not on the whitelist, or everyone while the whitelist cannot be read.

#### Ready-now set

`SERVER_COMMUNITY_WELCOME_VARIANTS`

```text
[["Welcome to The UNCs. Good games, older knees.","Get whitelisted: theuncsgaming.com/whitelist"],["Aged a little while you waited? Welcome to The UNCs.","Apply for the whitelist: theuncsgaming.com/whitelist"],["You made it. The UNCs salute your patience and your lower back.","Sign in with Discord and apply: theuncsgaming.com/whitelist"],["Welcome to The UNCs. Grab a squad, take the hill, mind your knees.","Discord and whitelist: theuncsgaming.com"],["Reading glasses on, soldier. The hill will not hold itself.","Welcome to The UNCs: theuncsgaming.com"],["Welcome in. Fast trigger fingers, earned naps.","Join the crew: theuncsgaming.com/whitelist"],["Long queue? We noticed. Welcome to The UNCs.","Thanks for your patience. Website: theuncsgaming.com"],["Welcome to The UNCs. Hydrate, squad up, use comms.","Find the crew at theuncsgaming.com"]]
```

`SERVER_COMMUNITY_ROUND_MESSAGES`

```text
["GG! Get whitelisted at theuncsgaming.com/whitelist. Thanks for playing on The UNCs.","GG, all. Stretch, hydrate, run it back. theuncsgaming.com","GG! Good games, older knees. Join the crew: theuncsgaming.com","GG! More games, more crew: theuncsgaming.com/whitelist","GG. Thanks for playing on The UNCs. Discord and whitelist: theuncsgaming.com"]
```

#### Queue-priority set

Only for a server where both reserved-slot checks above have passed.

`SERVER_COMMUNITY_WELCOME_VARIANTS`

```text
[["Welcome to The UNCs. Good games, older knees.","Long queue? Get queue priority at theuncsgaming.com/whitelist"],["Aged a little while you waited? Welcome to The UNCs.","Less queue next time: theuncsgaming.com/whitelist"],["You made it. The UNCs salute your patience and your lower back.","Tired of queues? theuncsgaming.com/whitelist"],["Welcome to The UNCs. Grab a squad, take the hill, mind your knees.","Discord and whitelist: theuncsgaming.com"],["Reading glasses on, soldier. The hill will not hold itself.","Welcome to The UNCs: theuncsgaming.com"],["Welcome in. Fast trigger fingers, earned naps.","Less queue, more crew: theuncsgaming.com/whitelist"],["Long queue? We noticed. Welcome to The UNCs.","Get queue priority at theuncsgaming.com/whitelist"],["Welcome to The UNCs. Hydrate, squad up, use comms.","Find the crew at theuncsgaming.com"]]
```

`SERVER_COMMUNITY_ROUND_MESSAGES`

```text
["GG! Get whitelisted at theuncsgaming.com/whitelist. Thanks for playing on The UNCs.","GG, all. Stretch, hydrate, run it back. theuncsgaming.com","GG! Good games, older knees. Join the crew: theuncsgaming.com","GG! Less queue, more crew: theuncsgaming.com/whitelist","GG. Thanks for playing on The UNCs. Discord and whitelist: theuncsgaming.com"]
```

### Recommended whitelisted welcome copy

Four two-message variants for `SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS`, for use with either standard set above. They welcome regulars back without asking them to get whitelisted, and promise no queue priority, rewards or points. They are not live until the variable is set in the deployment. Before setting it, confirm that the Steam group is still named `UNCs Wardogs` and that theuncsgaming.com still links the Discord.

| #   | First message                                           | Second message                                   |
| --- | ------------------------------------------------------- | ------------------------------------------------ |
| 1   | `Welcome back to The UNCs. Knees warmed up?`            | `Find regulars in our Steam group: UNCs Wardogs` |
| 2   | `Good to see you, unc. Squad up and take the hill.`     | `Discord: theuncsgaming.com`                     |
| 3   | `Welcome back. Hydrate, use comms, play the objective.` | `Thanks for being part of the crew.`             |
| 4   | `The UNCs salute you. Reading glasses on, soldier.`     | `Server quiet? Bring a friend and help seed.`    |

Paste this exact single-line value into the deployment, without surrounding quotes:

`SERVER_COMMUNITY_WHITELISTED_WELCOME_VARIANTS`

```text
[["Welcome back to The UNCs. Knees warmed up?","Find regulars in our Steam group: UNCs Wardogs"],["Good to see you, unc. Squad up and take the hill.","Discord: theuncsgaming.com"],["Welcome back. Hydrate, use comms, play the objective.","Thanks for being part of the crew."],["The UNCs salute you. Reading glasses on, soldier.","Server quiet? Bring a friend and help seed."]]
```

`src/server-community/recommended-copy.spec.ts` also checks that this table, the paste value and `.env.example` agree, pass startup validation and keep every message under 200 characters; that no message mentions the whitelist, queues, priority, rewards, points, bonuses or "free"; and that no variant repeats one from the standard sets.

### Newcomer wording and launch state

The approved UNCs welcome sequence is two short messages, starting after the loading delay and spaced at least twenty seconds apart:

1. `Welcome to The UNCs! Website: theuncsgaming.com`
2. `Get whitelisted: theuncsgaming.com/whitelist. Sign in with Discord and apply on the website.`

The approved round message is `GG! Get whitelisted at theuncsgaming.com/whitelist. Thanks for playing on The UNCs.` It may arrive as the next round loads; it does not announce a winner or claim an exact match-end trigger. Voting copy stays out of live welcomes while voting is off.

Dennis removed promotional “free” wording and the seeding welcome line. Seeding remains a separate community activity: joining a quiet server to help a match get going. Do not promise points, automatic whitelist rewards, queue tiers or XP/cash bonuses. Existing whitelist grants stay intact. Discord is the identity/community step; applications are completed on the website. October 2 read-only inspection matched one genuine website request and applied staff approval to its active, saved game whitelist entry. The applicant's own returned status screen and actual queue experience remain unobserved.

The separate Discord guild-join welcome also points newcomers to the updated [welcome guide](https://discord.com/channels/82988952587337728/1547153158931877959/1555406360357642390). Natural Gramps messages on October 1 at 23:29 EDT and October 2 at 04:05 EDT used that shorter template. The guide supplies the server join code and website application link. This is observed message delivery, not merely the source-code default; no test welcome was sent.

Import `ServerCommunityModule` in `AppModule`; export `AdminStore` from `AdminModule`. The existing global Necord module supplies its Discord `Client`. No new gateway listener, intent, or slash command is registered.

## Observations and delivery

One non-overlapping loop reads current status and players through the existing client. The dashboard and worker share in-flight reads and observations for up to five seconds; failed reads are not cached, and mutations discard cached observations. The next observation is scheduled five seconds after an occupied pass, fifteen seconds after an empty pass, or thirty seconds after a failed read. Network work adds to these intervals. The client's RCON pause/`Retry-After` handling remains in force. Polling is necessary because no supported join or match-ended push event is documented. With whitelisted welcome variants configured, an observation with new joiners may also read the running whitelist, at most once per five minutes per server (see [Welcomes for whitelisted players](#welcomes-for-whitelisted-players)).

Startup, a failed observation, or an observation gap greater than thirty seconds establishes a new baseline without messages. This deliberately misses activity during downtime instead of replaying welcomes or old rounds. Names and clan tags are not identities; welcome detection uses SteamID64.

A missing player remains remembered for sixty seconds. During a detected round transition, known players remain remembered for up to three minutes to tolerate map loading. The first populated return and observations that themselves reveal a transition suppress join messages, including when the game exposes the new map only after loading. A status response reporting zero players suppresses welcomes even if the parallel roster is still populated. New arrivals during these suppressed samples can miss their welcome. Loading longer than the bounded grace can still look like a new session.

At most one RCON message is attempted per successful pass. The queue holds at most sixty-four items (each either a round notice or one recipient's remaining welcome sequence). A welcome waits for the loading delay; each later message waits at least the configured spacing after the previous request completes successfully and its result is saved. Due times are minimums, not exact delivery guarantees. Waiting items do not block ready recipients. Every message expires sixty seconds after it becomes due; large bursts may therefore skip welcomes. Pending round broadcasts take priority.

Disconnect, failed observation, baseline reset or shutdown discards the recipient's remaining sequence. A failed, pending or unknown send, or failure saving its audit outcome, ends that sequence without retrying it. Queues are never replayed on restart. These are courtesy messages, not guaranteed delivery or proof a client displayed the popup.

Each attempted game message receives a UUID and durable `AdminStore.begin` record before its request. The actor is explicitly `system:server-community` / `Gramps community messages`. A failed journal insert prevents sending. An existing action ID is not sent again. A definite refusal is recorded as failed; an uncertain request is unknown. There is no automatic mutation retry, including after a failure saving its final audit result. An unresolved `started` record must not be interpreted as successful delivery.

## Round-transition limitations

The worker does **not** receive an authoritative end-of-match event and does not guarantee delivery on the results screen. It detects:

- A changed map.
- A supplied, nonnegative `matchSeconds` clock rolling back by more than thirty seconds.
- When both clocks are not available, all of the same reported factions resetting to zero after a positive score.

An ordinary score decrease does not trigger a message. If both clocks are present and have not rolled back, score changes alone do not trigger one. Reset plus subsequent map travel within sixty seconds is treated as one transition. The message waits up to three minutes for a populated status and roster; after that it is discarded. Map loading may delay delivery until the next round.

Same-map rounds can be missed when there is no clock and polling misses the all-zero reset. Restarts/administrative map changes can resemble round transitions. The message makes no winner, final-score, score-cap, or MVP claim. `scoreTick` is a scoring interval, never a match clock. Feed `matchId` is not used: public observations found it unchanged across map changes.

## Discord status card

The worker only edits the configured message after verifying its guild and bot author. It never creates or replaces messages, even if the configured message was deleted. Gramps must be able to view the channel, read its message history, and edit its own message. Prepare the message separately before enabling this feature.

The card shows server/map labels, player count, faction scores, optional reported match minutes, and the last observation time. Game-controlled labels are normalized to plain text; player names and SteamIDs are not included. Discord mentions are explicitly disabled. Existing embeds on the selected message are cleared, so select a message dedicated to this card.

Changed cards are edited no more than once per minute; unchanged cards refresh after five minutes. Failed attempts are also spaced by a minute. Unreachable games show an unavailable/stale label rather than a fabricated empty server. If Gramps itself stops, its message cannot update, so always inspect the last-observed timestamp. No Discord message creation or external delivery was exercised during implementation tests.

## Cutover and operating limits

Run one Gramps replica with these switches enabled. There is no cross-process leader election; two active replicas can independently infer events and send duplicates. Observation state and queued messages are intentionally in memory and are discarded on restart.

Before activation, verify the current production capabilities, the configured existing Discord message, and the intended literal messages. Disable the overlapping third-party **game** welcome, round-announcement, and status-card features before enabling their Gramps replacements. Leave the separate Discord guild-join welcome enabled if desired. Do not change the existing `WDServerFeed` URL/token for this worker.

Tests use mocked game, database, and Discord boundaries. They verify startup/outage suppression, map-load grace, conservative round detection, loading delay, spacing from slow actual sends, other-recipient progress, cancellation, configuration validation and precedence, randomized variant and round-message choice without immediate repeats (using an injected, deterministic random source), whitelisted and ordinary welcome pools with separate history per server, the whitelist cache, fallback to the ordinary welcome when the whitelist cannot be read, bounded delivery, durable-before-send ordering, uncertain outcomes, and edit-only Discord behavior. They do not verify the production server's capabilities, private-message popup appearance, or whether clients actually display a delivered message.

Protocol evidence checked 30 September 2026: [official RCON client](http://rcon.wardogs.com/js/api.js), [official polling configuration](http://rcon.wardogs.com/js/config.js), [Warcon live-build observations](https://github.com/warcon-app/warcon/blob/main/docs/wardogs-api.md), and [Warcon observation/rule implementation](https://github.com/warcon-app/warcon/blob/main/src/lib/server/trigger-rules.ts). Warcon is implementation evidence from another host, not verification of The UNCs production build.

## Automatic community map voting

`MAP_VOTES_ENABLED=false` is the default and remains off on production. **The map/mode switches and score reminders below are prepared for review, not released or activated.** Existing migration `0003_lovely_caretaker.sql` contains the original voting tables. The new saved controls require a human-generated, reviewed migration for `map_vote_policies` and the nullable `map_votes.automation` JSON column. Do not deploy this branch against the old schema. Passing isolated tests does not prove production migration state.

### Saved map/mode controls and score reminders — pending migration and acceptance

Administrators get five independent switches: automatic voting, map choices, mode choices, score-50 updates and score-85 reminders. Automatic voting and both reminders default off. Preferences can be saved with the global live gate off; activation requires a separate confirmation click. An explicit server target, server connection check and saved version prevent a stale form overwriting another administrator. The responsible administrator is recorded and rechecked before automatic effects. Saving controls for one server has no effect on another.

Automatic ballots use up to five validated map/mode combinations from the saved rotation. Repeated lighting/layout variants do not fill every slot with the same map and mode. Turn map choices off for modes on the current map; turn mode choices off to keep the current rotation entry's mode. At least two suitable choices are required. Add Normal/Infantry/Hardcore combinations to the rotation if they should be offered; the worker does not invent unsupported IDs or automatically turn on an event preset. Manual override ballots can also offer the same map with different supported modes/layouts. Exact catalog IDs survive review and winner queueing.

[BULKHEAD's TOP QUESTIONS announcement](https://store.steampowered.com/news/app/1867240/view/1825093633182385), rechecked through Steam's official news API on October 2, specifies first to 100 points. These reminders use the **leading faction's score**, not a match-time estimate or total of all factions. The independent updates occur at 50 and 85 points; the ballot closes and considers its winner at 95. Each update posts full current totals and a ballot link in Discord, plus a short leader/tie/no-votes message in game. A jump directly to the late milestone produces only the late update. Every reminder is claimed durably before sending; lost responses are not retried, including after a process restart. The in-game broadcast has its own normal action receipt.

This score policy opens only after 120 seconds of stable observed rotation and with a fresh score below 85. It does not need an invented end-of-match event. If the API reports a different score cap, scores are unavailable/stale, or the match cannot be confirmed, no score-triggered effect is sent. A detected score reset, changed rotation/revision/connection or reaching 100 cancels without queueing. Three hours is an expiry that cancels, not a timed fallback that queues. A same-map/index restart with no clock and no observed score reset remains indistinguishable from the old match; controlled testing must cover this existing source limitation. No hard guarantee about time remaining is made.

Switch changes apply to the next ballot. Switching off either reminder also stops future sends from an existing ballot; turning it on does not retroactively enroll a ballot that opened without it. Turning automatic voting off closes open automatic ballots without a queue write. It does not undo a previously queued winner or recall an already dispatched request. The old `MAP_VOTES_AUTOMATIC` environment recipes are no longer used: one saved dashboard policy controls each server. Close any existing timed ballots and remove obsolete recipes before cutover; older records do not identify whether timed publication was manual or automatic.

Human release step: generate and review one migration from `src/database/schema.ts`, containing only the new policy table and nullable ballot column. Run the complete PostgreSQL storage/concurrency suite and migration-drift check with that migration. Then review the isolated UI and controlled Discord/game rehearsal; **Dennis explicitly requested keeping voting/reminders off until that testing is agreed and complete.** No agent-generated migration, production enable change or test broadcast is part of this work.

### Setup and operation

While voting is off, an administrator can open **How to enable voting → Check voting setup**. This explicit, uncached read checks the expected voting columns, any unfinished ballot on the selected server, the configured Discord channel's read/post permissions, the automatic policy's fresh server-specific administrator access and the current ordered rotation position. It never creates, closes or resumes a ballot, posts a message, enables a policy or writes to the game. Checks report independently and provider errors are redacted. Readable tables do not by themselves prove database write privileges, correct indexes, Discord delivery or game adoption; inspect the existing migration/deployment and use the designated integration evidence before activation. Unfinished ballots deserve review because enabling the worker can resume stored work.

After storage and controlled integration review, configure `MAP_VOTES_CHANNEL_ID` as a text channel in `ADMIN_GUILD_ID`. Gramps needs View Channel, Send Messages and Read Message History. No new gateway intent, slash command, third-party bot, paid service or voice listener is required. Community members who completed Discord membership screening can vote with buttons. There is one current choice per Discord account, not verified Steam identity or verified active-player eligibility. Bot accounts cannot vote; account-based voting does not eliminate alternate accounts.

Each configured server waits for an editable ordered rotation position to remain observed for two minutes. A read gap longer than a minute resets that wait. Failed validation or missing administrator access prevents publication. Map-only voting excludes the current map; mode voting can keep that map with another supported mode. Lighting and layout remain the validated values of the selected rotation entries.

Administrators see live counts and automatic progress in **Match & maps** and **Map votes**. The latter keeps manual publication under **Staff override** when automation is configured. Staff can close an open ballot or queue a different next map. A manual settings/queue change invalidates the ballot's original revision so its winner cannot overwrite that change. Staff may also review and publish a replacement with 2–5 distinct map/mode/layout combinations and a 2–30 minute duration. Viewers and moderators cannot read private ballot history or control voting.

The Discord message states its closing rule, one-changeable-vote rule and rotation fallback for ties or no votes. It includes modifiers and never publishes staff reasons, voter IDs or connection settings. Mentions are disabled. Dashboard counts come from stored member choices and refresh with the dashboard; Discord displays final counts after closure.

The ballot is stored before Discord publication. A partial unique index allows one active/unresolved ballot per server. A composite ballot/member key replaces a member's previous selection. Row locks serialize voting, close claims and cancellation across bot processes. Staff and automatic creation share a per-server transaction lock; automatic creation also checks the last observed ballot ID, preventing stale workers from opening duplicate ballots even after another ballot closes. A deterministic nonce uses [recent-message deduplication from Discord](https://docs.discord.com/developers/resources/message#create-message) for transport retries; the application never automatically resends uncertain publication. The worker checks stored deadlines and configured server positions every fifteen seconds; network/database work can delay completion. Open ballots survive restarts. Publishing/closing records left unresolved for two minutes become **Needs review**, never automatically reacquired and replayed.

Closing counts votes once. A tie or no votes leaves the rotation unchanged without a game request. A winner requires the same configured endpoint, Discord guild/channel, original map and rotation index, editable ordered rotation and unchanged configuration revision. The creator's administrator access is checked again. The existing audited `map-next` action uses the ballot ID as its receipt ID, validates the current catalog and rotation position, writes with `If-Match`, and checks the saved rotation. **Winner queued** confirms the saved next rotation position; it does not prove the game has loaded that map. It never ends/restarts the current match. A failed check before sending a queue action closes the ballot without a write. An unconfirmed action remains **Needs review** and is not retried.

Voting can operate when the server omits its elapsed match clock: it targets the next slot at the observed rotation position. If a usable clock exists when opening, closure additionally requires the same estimated round start within thirty seconds; losing that clock then closes the ballot without queueing. With no clock, a restart at the same map/index cannot be distinguished from the original match. The latest recorded ballot prevents reopening at that same position, including after a bot restart, unless a usable clock demonstrates a new round. A reported clock reset restarts the observation delay. A score milestone is not an authoritative round event; no claim is made of an atomic round check with the game write.

**Close ballot** stops new votes for an open ballot, or acknowledges an uncertain result after staff inspect Discord and the next-map receipt in Action history. It records the closer, request ID, reason and previous result. It cannot undo a queued map, recall an already in-flight request, or cancel while the worker is closing. If a timed-out operation is still running, stop/inspect that instance before acknowledging its uncertain record. Missing action receipt means the operation may not have reached the game-action stage; it is not proof of a successful queue change. A failed Discord result edit leaves the dashboard authoritative and old buttons refuse votes. No replacement message is created.

Each ballot retains its configured server ID and private endpoint fingerprint. Closure rechecks its creator's administrator access on that server and uses that server's audited next-map path. Different servers may have independent ballots in the configured Discord channel. Close/resolve ballots before changing the guild, channel or game connection. Disable the feature flag and restart Gramps to stop it; inspect previously in-flight work before re-enabling it.

The loopback preview uses in-memory policies/ballots and simulated Discord/game clients only. Use its dashboard switches to rehearse automatic settings, or `PREVIEW_MAP_VOTES_ENABLED=false` to rehearse preparing preferences behind the disabled live gate. Restarting the preview clears its in-memory records. The visible preview banner remains present. Browser tests do not post Discord messages or contact the live Wardogs server. Real Discord screening/button delivery, permissions, migration deployment and game adoption need a designated integration test before activation.

## Optional 50v50 events

`SERVER_EVENTS_ENABLED=false` is the default and remains off on production. It neither queries event tables nor contacts the game while off. The existing committed `0003_lovely_caretaker.sql` contains `server_events` and `server_event_operations`; verify its application to the target database and controlled event behavior before activation, rather than requesting a duplicate migration. The PostgreSQL suite executes the checked-in migrations in a disposable database. Enabling the feature alone creates no event. Administrators must review and arm one in **Events**; moderators, viewers and community members receive no event controls.

This is supervised two-team automation using the documented faction PATCH and game messages, not a native 50v50 switch. Select two of the game's three current faction names. Server capacity must be at most 100; the worker checks a target-team limit of 50 before moving. It never kicks players to make room. There is no atomic reservation or team-move transaction exposed by the game: another player can switch between the check and the request. The next observation reassesses the roster. Disable overlapping third-party team balancers before a controlled activation.

Review a duration of 15–240 minutes (including the wait for the next round), a warning delay of 15–120 seconds, and an early balancing window of 60–600 seconds. Forced respawns are explicitly opt-in and default off. The event saves the original native population-lock value. If on, it changes only that field with the reviewed configuration revision; it records the exact resulting document revision before arming. Saved configuration is not proof that the running game has adopted it; verify application timing on the owner's controlled server test.

The first roster establishes a baseline. The worker waits for a subsequent observed round, broadcasts a warning, and starts the delay after that send succeeds and its outcome is recorded. New arrivals absent from that warning receive a private warning before a move. The worker moves one eligible player per pass: excluded-team players go to the smaller chosen team; during the early window, active teams differing by more than one player can also be balanced. After the early window, it only redirects players on the excluded team. A player's confirmed move is remembered for that round; returning to the excluded team after a move requires staff review rather than repeated forced moves. Cash, score, display name, Discord membership and supporter status never determine move eligibility.

Buying remains available. Sorting many players can take several minutes. Messages are accepted requests, not proof the client displayed or read them. With respawns off, the game may need the player's next normal respawn to apply the assignment. With respawns on, only a confirmed changed assignment schedules a later kill request; an already-correct assignment or rejected precondition does not. The player, current faction and estimated round are checked again before the kill. Gear loss remains possible, including if the player respawns or buys between checks. Never advertise this as loss-free or a verified pre-purchase freeze.

Every effect has a durable event-operation intent before the existing audited action service runs. Operation claims use row locks and versions, with one active/unresolved event per server. JSON comparisons are structural so PostgreSQL key ordering does not break exact request replay. Stop requests retain staff identity and reason, and prevent new moves from being claimed or sent after the final stop check. Already in-flight requests cannot be recalled. Settling a move cannot remove a concurrent stop. Uncertain sends/readbacks/audit completion require **Needs review**; an interrupted operation older than two minutes is preserved and never automatically replayed. Old receipts remain available if a later manual restoration supersedes their pointer.

Automatic restoration changes only the population lock, and only when the saved document still has the exact revision produced by the event or the lock is already at its original value. Newer edits are not overwritten. If the lock was originally off, a clean stop needs no configuration write. For a conflict or uncertain operation, stop the event, inspect its action receipts, stop the affected old Gramps instance if it might still be running, then use **Review restoration**, check the warning and current lock, and click **Restore reviewed lock**. No phrase needs to be typed. Restoration does not undo team assignments, refund gear, or prove running-game adoption. Do not disable the worker or change its endpoint before arranging restoration; disabling a feature cannot perform cleanup while it is off.

The game must supply usable round timing before an event can be armed. The dashboard explains missing timing before review and checks again when the start review opens. **Check round timing** only reads status and keeps the draft; it does not start an event. **Stop event** remains available without a clock or game-status read.

Round detection uses map plus an estimated start from the elapsed clock (30-second tolerance), not an authoritative round ID. Missing/stale clocks or mismatched population/roster observations produce no move. Unlinked/duplicate identities, unknown factions, excess capacity, a re-enabled team lock, changed endpoint/guild or lost administrator access stop automation for review. Observation gaps over 30 seconds reset the baseline and wait for the next round. Brief same-map resets below the tolerance and transitions between the final check and game request cannot be ruled out. A controlled integration test must cover those limits, warning visibility, request allowance, team codes, respawn effects and configuration adoption before activation.

The worker uses completion-paced observations because no verified round-start event source is available. It performs at most one recorded effect per pass, shares cached roster observations with existing readers, and budgets ten requests per interval using the advertised allowance (minimum five seconds, ten seconds if unknown). A reported allowance below 30 requests/minute prevents arming. This is a conservative estimate, not a global host quota coordinator; keep one active observation replica for launch and account for the dashboard and community worker. Storage claims still prevent two replicas from executing the same operation. Slow/rate-limited observations may cause the next-round fallback.

Events are scoped to the selected server, with a private endpoint fingerprint and an independent observation timer. Effects freshly check the responsible administrator's access on that server. **Discord voice-channel sorting, Blue preference, and friend groups together or against one another remain research-only and are not implemented.** No new gateway intent, voice listener, audio access, third-party bot or paid service is introduced.
