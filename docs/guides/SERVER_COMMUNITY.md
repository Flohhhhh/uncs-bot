# Gramps server community messages

This optional, single-instance worker provides in-game welcome whispers, generic round-transition broadcasts, and edits to one existing Discord status message. All switches default to `false`. Nothing is activated by deploying the code alone, and no game configuration or kill-feed destination is changed.

## Configuration

The worker uses the existing `WardogsClient` and requires RCON connection settings. Its own flags control activation; it does not require staff OAuth or `ADMIN_ENABLED`. The Discord card additionally requires `ADMIN_GUILD_ID` and the configured bot-owned message. The `admin_actions` table was deployed and checked through the combined production launch migration on September 30; see [Database prerequisite](ADMIN_DASHBOARD.md#database-prerequisite--launch-migration-applied). The worker remains off, pending connection checks and announcement cutover. Other deployments still need the reviewed schema. This module adds no database tables or migrations.

| Variable                                   | Default / purpose                                                |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `SERVER_COMMUNITY_ENABLED`                 | `false`; master switch                                           |
| `SERVER_COMMUNITY_WELCOME_ENABLED`         | `false`; whisper to observed new connections                     |
| `SERVER_COMMUNITY_ROUND_ENABLED`           | `false`; generic message at an inferred round transition         |
| `SERVER_COMMUNITY_DISCORD_STATUS_ENABLED`  | `false`; edit the configured existing Discord message            |
| `SERVER_COMMUNITY_WELCOME_MESSAGE`         | `Welcome to The UNCs! Squad up and enjoy the server.`            |
| `SERVER_COMMUNITY_WELCOME_MESSAGES`        | Optional JSON array of 1–4 messages; replaces the single message |
| `SERVER_COMMUNITY_WELCOME_DELAY_SECONDS`   | `10`; first-message loading delay, 0–60 seconds                  |
| `SERVER_COMMUNITY_WELCOME_SPACING_SECONDS` | `20`; minimum time after a confirmed send, 10–120 seconds        |
| `SERVER_COMMUNITY_ROUND_MESSAGE`           | `GG! Thanks for playing on The UNCs. See you next round.`        |
| `SERVER_COMMUNITY_DISCORD_CHANNEL_ID`      | Existing Discord channel in `ADMIN_GUILD_ID`                     |
| `SERVER_COMMUNITY_DISCORD_MESSAGE_ID`      | Existing message authored by this Gramps bot                     |

Messages are literal, single-line text, 1–200 characters. There is no placeholder expansion or silent truncation. Invalid deployment values fail startup validation; the send boundary also refuses invalid text. When the optional array is absent, the existing single-message setting still works with the configured initial delay. Each feature is independent; status requires both message/channel IDs. Settings are deployment configuration, not editable dashboard controls.

### Newcomer wording and launch state

The disabled example in `.env.example` works before website intake opens: welcome, free whitelist information/Discord at the website, then seeding. It does not claim that the application flow is already available. After website publication, both OAuth callbacks and a controlled application rehearsal are verified, the second message can become:

`Free whitelist: apply at theuncsgaming.com/whitelist. Sign in with Discord, then finish on the website. Staff review is required; donating is optional.`

The seeding message is:

`Quiet server? Help seed: join, play a round and invite a friend. Thanks for getting the match going!`

Seeding means helping an initially quiet server gain enough real players for a match. This wording does not promise points, automatic whitelist rewards, a queue tier or a current XP/cash bonus. The legacy whitelist stays intact. Discord is the identity/community step; new applications are completed on the website, not handed back to a Discord request channel. Check the live flow before changing the welcome text.

Import `ServerCommunityModule` in `AppModule`; export `AdminStore` from `AdminModule`. The existing global Necord module supplies its Discord `Client`. No new gateway listener, intent, or slash command is registered.

## Observations and delivery

One non-overlapping loop reads current status and players through the existing client. The dashboard and worker share in-flight reads and observations for up to five seconds; failed reads are not cached, and mutations discard cached observations. The next observation is scheduled five seconds after an occupied pass, fifteen seconds after an empty pass, or thirty seconds after a failed read. Network work adds to these intervals. The client's RCON pause/`Retry-After` handling remains in force. Polling is necessary because no supported join or match-ended push event is documented.

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

Tests use mocked game, database, and Discord boundaries. They verify startup/outage suppression, map-load grace, conservative round detection, loading delay, spacing from slow actual sends, other-recipient progress, cancellation, configuration validation, bounded delivery, durable-before-send ordering, uncertain outcomes, and edit-only Discord behavior. They do not verify the production server's capabilities, private-message popup appearance, or whether clients actually display a delivered message.

Protocol evidence checked 30 September 2026: [official RCON client](http://rcon.wardogs.com/js/api.js), [official polling configuration](http://rcon.wardogs.com/js/config.js), [Warcon live-build observations](https://github.com/warcon-app/warcon/blob/main/docs/wardogs-api.md), and [Warcon observation/rule implementation](https://github.com/warcon-app/warcon/blob/main/src/lib/server/trigger-rules.ts). Warcon is implementation evidence from another host, not verification of The UNCs production build.

## Optional Discord map ballots — separate feature

`MAP_VOTES_ENABLED=false` is the default. This feature adds source definitions for `map_votes` and `map_vote_ballots`. **A human must generate, review and apply the combined migration before enabling it.** No committed migration was generated or edited by this work. Deploying with the flag off does not query these tables or contact Discord/the game for voting. The PostgreSQL tests use an explicit disposable fixture for this proposed schema; that is not a reviewed deployment migration.

After schema and controlled integration review, configure `MAP_VOTES_CHANNEL_ID` as a text channel in `ADMIN_GUILD_ID`. Gramps needs View Channel, Send Messages and Read Message History. No new gateway intent, slash command, third-party bot, paid service or voice listener is required. Administrators create/review/close ballots in **Map votes**; viewers and moderators cannot read that private history. Community members who completed Discord membership screening can vote with buttons. There is one current choice per Discord account, not verified Steam identity or verified active-player eligibility. Bot accounts cannot vote; account-based voting does not eliminate alternate accounts.

Staff choose 2–5 distinct maps other than the current map, advertised modes/lighting/layouts, 2–30 minutes, and a recorded reason. They review the exact options before publishing. The Discord message states the duration, one-changeable-vote rule, first-listed tie rule and no-votes fallback. It includes map modifiers and never publishes staff reasons, voter IDs or connection settings. Mentions are disabled. Results appear after closure; the dashboard does not invent live vote totals.

The ballot is stored before Discord publication. A partial unique index allows one active/unresolved ballot per server. A composite ballot/member key replaces a member's previous selection. Row locks serialize voting, close claims and cancellation across bot processes. A deterministic nonce uses [recent-message deduplication from Discord](https://docs.discord.com/developers/resources/message#create-message) for transport retries; the application never automatically resends uncertain publication. The worker checks stored deadlines every fifteen seconds; network/database work can delay completion. Open ballots survive restarts. Publishing/closing records left unresolved for two minutes become **Needs review**, never automatically reacquired and replayed.

Closing counts votes once. No votes leaves the rotation unchanged without a game request. A winner requires the same configured endpoint, Discord guild/channel, original map, estimated round start (within thirty seconds), editable ordered rotation and unchanged configuration revision. The creator's administrator access is checked again. The existing audited `map-next` action uses the ballot ID as its receipt ID, validates the current catalog and rotation position, writes with `If-Match`, and checks the saved rotation. **Winner queued** confirms the saved next rotation position; it does not prove the game has loaded that map. It never ends/restarts the current match. There is no authoritative round ID here: clock-based round detection retains the limitations of the game's observations and cannot guarantee no round transition between the last check and the write.

**Close ballot** stops new votes for an open ballot, or acknowledges an uncertain result after staff inspect Discord and the next-map receipt in Action history. It records the closer, request ID, reason and previous result. It cannot undo a queued map, recall an already in-flight request, or cancel while the worker is closing. If a timed-out operation is still running, stop/inspect that instance before acknowledging its uncertain record. Missing action receipt means the operation may not have reached the game-action stage; it is not proof of a successful queue change. A failed Discord result edit leaves the dashboard authoritative and old buttons refuse votes. No replacement message is created.

This release accepts only explicit server ID `primary`. The stored server ID and private endpoint fingerprint prevent a restarted worker from intentionally applying an old ballot to a newly configured endpoint. This is not complete multi-server support: the dashboard, grants, feeds and general action history still require the broader server-scoping work. Close/resolve ballots before changing the guild, channel or game connection. To stop this feature, disable its flag and restart Gramps; inspect any previously in-flight operation and Discord message before later re-enabling it.

The loopback preview uses in-memory ballots and simulated publication only. Its visible preview banner remains present. Browser tests do not post Discord messages or contact the live Wardogs server. Real Discord screening/button delivery, permissions, migration deployment and game adoption need a designated integration test before activation.
