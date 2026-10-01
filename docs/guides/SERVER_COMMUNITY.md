# Gramps server community messages

These optional workers provide welcome whispers, round-transition broadcasts and edits to an existing Discord status message per configured server. Run one community-worker instance per deployment; its in-memory queue is not a cross-process delivery claim. All switches default to `false`. Deployment alone does not activate them or change game configuration or feed destinations.

## Multiple servers

Omit `WARDOGS_SERVERS` to retain the original `primary` connection. To expand, configure its JSON array with permanent `id`, public `name`, private `rconUrl` and `password` entries. Preserve the original server as `primary`; never reuse an ID for a different game. A registry requires explicit staff selection and rejects legacy unscoped game routes. Optional per-server `staffRoles` narrow community permissions: absent lists inherit the community role, empty lists deny non-owners, and no list can promote a community viewer or moderator. Configured owners retain administrator access.

Welcomes and round messages share wording and feature flags, but each server has its own baseline, bounded queue, timer and backoff. Configure a distinct `communityStatus` object with `channelId` and bot-owned `messageId` for each desired card. Registry mode never copies the legacy shared message to every server; absent IDs mean no card output. Destinations must belong to `ADMIN_GUILD_ID`.

Each server may have a unique `feedToken`, separate from every game password. Deliver to `/api/ingest/servers/ID/events`. The receiver derives the stable identity from that authenticated route, never the payload's per-boot UUID or display name. Public labels use `/community/api/servers`; rankings use `/community/api/servers/ID/leaderboard`. Staff routes use `/admin/api/servers/ID/...` with ordinary session/role checks; mutations also require the endpoint version from the staff server list. Registry credentials never belong in website files.

The [release audit](ADMIN_RELEASE_AUDIT.md#multiple-server-implementation--isolated-validation-in-progress) records migration and cutover requirements. Applications and combat need reviewed schema changes even for a single server. An application approval is scoped to its server; supporter status grants no game access. New website selectors depend on this backend release. No live expansion or feature activation has been performed.

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

Each ballot retains its configured server ID and private endpoint fingerprint. Closure rechecks its creator's administrator access on that server and uses that server's audited next-map path. Different servers may have independent ballots in the configured Discord channel. Close/resolve ballots before changing the guild, channel or game connection. Disable the feature flag and restart Gramps to stop it; inspect previously in-flight work before re-enabling it.

The loopback preview uses in-memory ballots and simulated publication only. Its visible preview banner remains present. Browser tests do not post Discord messages or contact the live Wardogs server. Real Discord screening/button delivery, permissions, migration deployment and game adoption need a designated integration test before activation.

## Optional 50v50 events

`SERVER_EVENTS_ENABLED=false` is the default. It neither queries event tables nor contacts the game while off. Source definitions for `server_events` and `server_event_operations` require a **human-generated and reviewed combined migration** before enabling. The PostgreSQL suite's disposable schema fixture is not a deployment migration. Enabling the feature alone creates no event. Administrators must review and arm one in **Events**; moderators, viewers and community members receive no event controls.

This is supervised two-team automation using the documented faction PATCH and game messages, not a native 50v50 switch. Select two of the game's three current faction names. Server capacity must be at most 100; the worker checks a target-team limit of 50 before moving. It never kicks players to make room. There is no atomic reservation or team-move transaction exposed by the game: another player can switch between the check and the request. The next observation reassesses the roster. Disable overlapping third-party team balancers before a controlled activation.

Review a duration of 15–240 minutes (including the wait for the next round), a warning delay of 15–120 seconds, and an early balancing window of 60–600 seconds. Forced respawns are explicitly opt-in and default off. The event saves the original native population-lock value. If on, it changes only that field with the reviewed configuration revision; it records the exact resulting document revision before arming. Saved configuration is not proof that the running game has adopted it; verify application timing on the owner's controlled server test.

The first roster establishes a baseline. The worker waits for a subsequent observed round, broadcasts a warning, and starts the delay after that send succeeds and its outcome is recorded. New arrivals absent from that warning receive a private warning before a move. The worker moves one eligible player per pass: excluded-team players go to the smaller chosen team; during the early window, active teams differing by more than one player can also be balanced. After the early window, it only redirects players on the excluded team. A player's confirmed move is remembered for that round; returning to the excluded team after a move requires staff review rather than repeated forced moves. Cash, score, display name, Discord membership and supporter status never determine move eligibility.

Buying remains available. Sorting many players can take several minutes. Messages are accepted requests, not proof the client displayed or read them. With respawns off, the game may need the player's next normal respawn to apply the assignment. With respawns on, only a confirmed changed assignment schedules a later kill request; an already-correct assignment or rejected precondition does not. The player, current faction and estimated round are checked again before the kill. Gear loss remains possible, including if the player respawns or buys between checks. Never advertise this as loss-free or a verified pre-purchase freeze.

Every effect has a durable event-operation intent before the existing audited action service runs. Operation claims use row locks and versions, with one active/unresolved event per server. JSON comparisons are structural so PostgreSQL key ordering does not break exact request replay. Stop requests retain staff identity and reason, and prevent new moves from being claimed or sent after the final stop check. Already in-flight requests cannot be recalled. Settling a move cannot remove a concurrent stop. Uncertain sends/readbacks/audit completion require **Needs review**; an interrupted operation older than two minutes is preserved and never automatically replayed. Old receipts remain available if a later manual restoration supersedes their pointer.

Automatic restoration changes only the population lock, and only when the saved document still has the exact revision produced by the event or the lock is already at its original value. Newer edits are not overwritten. If the lock was originally off, a clean stop needs no configuration write. For a conflict or uncertain operation, stop the event, inspect its action receipts, stop the affected old Gramps instance if it might still be running, then use **Review restoration** with the current revision and typed confirmation. Restoration does not undo team assignments, refund gear, or prove running-game adoption. Do not disable the worker or change its endpoint before arranging restoration; disabling a feature cannot perform cleanup while it is off.

Round detection uses map plus an estimated start from the elapsed clock (30-second tolerance), not an authoritative round ID. Missing/stale clocks or mismatched population/roster observations produce no move. Unlinked/duplicate identities, unknown factions, excess capacity, a re-enabled team lock, changed endpoint/guild or lost administrator access stop automation for review. Observation gaps over 30 seconds reset the baseline and wait for the next round. Brief same-map resets below the tolerance and transitions between the final check and game request cannot be ruled out. A controlled integration test must cover those limits, warning visibility, request allowance, team codes, respawn effects and configuration adoption before activation.

The worker uses completion-paced observations because no verified round-start event source is available. It performs at most one recorded effect per pass, shares cached roster observations with existing readers, and budgets ten requests per interval using the advertised allowance (minimum five seconds, ten seconds if unknown). A reported allowance below 30 requests/minute prevents arming. This is a conservative estimate, not a global host quota coordinator; keep one active observation replica for launch and account for the dashboard and community worker. Storage claims still prevent two replicas from executing the same operation. Slow/rate-limited observations may cause the next-round fallback.

Events are scoped to the selected server, with a private endpoint fingerprint and an independent observation timer. Effects freshly check the responsible administrator's access on that server. **Discord voice-channel sorting, Blue preference, and friend groups together or against one another remain research-only and are not implemented.** No new gateway intent, voice listener, audio access, third-party bot or paid service is introduced.
