# Gramps staff alerts

Gramps can tell staff, in a private Discord channel, when the game server looks unhealthy, sits empty, has a player whose kill counters stand out, or has a player on the staff watch list join. It replaces the parts of the third-party "WarDogs Server Commands" bot (wardogsbot.com) that The UNCs used. That bot's game-server connection is being removed and must not be connected to the game server again. It may stay in Discord only to post its cross-community network-ban alerts in a private staff channel.

Everything here is off by default and **alert-only**.

## 1. What it does and does not do

Staff alerts **do**:

- Read the same cached RCON overview the dashboard uses (at most every 10 seconds while players are on and performance tracking is on, otherwise every 15 seconds, and 30 seconds after a failed read).
- Post an embed to one private staff channel, record every alert in memory for the staff API, and log `Staff alert <id> <kind> <server> <delivery>`.
- Read the live whitelist (the running reserved slots, never the server configuration file) only when a performance alert is about to fire and `STAFF_ALERTS_PERFORMANCE_SKIP_WHITELISTED=true`.

Staff alerts **never**:

- Kick, ban, unban, change the whitelist, change the map, or send any other game command. The monitor does not use `WardogsClient.execute` or `AdminService.act` and writes no `admin_actions` rows. Only a person acts, through the existing dashboard action path with their own staff identity.
- Hold a ban to apply later. There is no equivalent of WarDogs' "carried out the moment they join".
- Connect to WarDogs Server Commands. Gramps sends nothing to `wardogsbot.com`, stores no `wdp_` or `wdk_` key, and cannot read the WarDogs bot's Discord messages (its gateway intents stay at `Guilds` and `GuildMembers`, without `MessageContent`).
- Show SteamIDs or player names anywhere except the private staff channel, the authenticated staff API and the dashboard. Not in community channels, the status card, the public API, Discord link URLs or logs.
- Call a player a cheater. Performance alerts ask for a **review**; every alert says "Gramps took no action".

All alert state (records, reviews, snoozes, "never flag", cooldowns, peaks) is **in memory** and is lost when Gramps restarts. There is no table and no migration. Run **one replica**, the same rule as the community worker.

## 2. Setup

### Discord

1. Create a private text channel in the staff Discord server (`ADMIN_GUILD_ID`), for example `#gramps-staff-alerts`. It must not be the voting channel, the community channel, the weekly leaderboard channel or any server's status-card channel; Gramps refuses those (`community-channel`).
2. Deny **View Channel** to `@everyone`. If `@everyone` can view it, Gramps refuses to post and the status shows `public`.
3. Allow the staff roles to view it.
4. Give the Gramps bot, on that channel: **View Channel**, **Send Messages**, **Embed Links** and **Read Message History** (needed to note reviews on the posted message). No other permission is needed, apart from the ping option in step 5; Gramps never mentions `@everyone` or `@here` and sends no buttons.
5. Optional: create or choose a staff role to ping for high-severity alerts and copy its ID. It must not be the `@everyone` role (whose ID equals the guild ID). Discord only notifies a role when **Allow anyone to @mention this role** is on in the role's settings, or when the sender has **Mention @everyone, @here, and All Roles**. Turn on one of the two: the role setting, or that permission for Gramps on the staff channel. Gramps never changes the role or its own permissions, and still never mentions `@everyone` or `@here`. Until one is on, the status shows `ping: not-mentionable` and high alerts post without the ping.

### Railway variables

Start with health and seeding only:

```
STAFF_ALERTS_CHANNEL_ID=<private channel ID>
STAFF_ALERTS_ENABLED=true
STAFF_ALERTS_HEALTH_ENABLED=true
STAFF_ALERTS_SEEDING_ENABLED=true
# Optional, high-severity only (game down, prime-time empty, highlighted watch-list join):
# STAFF_ALERTS_PING_ROLE_ID=<staff role ID>
```

Then, a week later, `STAFF_ALERTS_PERFORMANCE_ENABLED=observe`, and after another week of calibration `true` (section 4). The full list with defaults is in `.env.example`; every setting is validated at boot, and JSON settings are never echoed in error messages.

To use the watch list (section 5), also set `STAFF_ALERTS_WATCHLIST_ENABLED=true` next to `STAFF_ALERTS_ENABLED=true`. It defaults to `false`, and without both flags Gramps ignores every `STAFF_ALERTS_WATCHLIST` entry: a listed player joins with no alert, no record and no log line.

After deploying, open `GET /admin/api/servers/<server>/staff-alerts` (or the dashboard's Staff alerts tab once it lands) and check that `channel.state` is `ok` and `ping` is `ok` or `off`. `not-mentionable` means a ping would notify nobody (step 5); `invalid` means the role is the `@everyone` role or is not in the staff server. If you set up the watch list, also check that `features.watchlist` is `true`.

## 3. Alert kinds

| Kind                    | Trigger                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Severity                                                 | Example                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `game-down`             | At least two failed reads spanning `HEALTH_DOWN_MINUTES` (10). Rate-limit pauses never count. Once per outage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | high (may ping)                                          | **Game unreachable for 10 min** · Could not reach RCON since 04:01 ET. Inferred from RCON reads.   |
| `game-back`             | Two good reads in a row, only after `game-down`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | info                                                     | **Game reachable again** · RCON answered again at 04:25 ET after 24 min.                           |
| `game-restart`          | The first good read after a read gap (over a minute between reads, failed or not) or two or more failed reads shows a map change, clock rollback or new round, players falling from 5+ to 1 or fewer, or a new build. After a single failed read, only a new build counts at once. Players falling to 1 or fewer there, or a full server (10+) emptying at a round boundary with no failed read, counts only if the roster stays near empty for 3 minutes, because a map load refills it sooner. At most one posted per 30 minutes; a restart held back by that limit is recorded only. | info; warning with `HEALTH_RESTART_PLAYERS`+ on          | **Likely restart** · Map Bakurani to Ozeti, players 34 to 0, connection lost 2 min (unscheduled).  |
| `game-build`            | `capabilities.build` changes (after a silent boot baseline). "Likely game update" when within 10 minutes of a restart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | info                                                     | **Game build changed** · Build CL-1 to CL-2, after a restart (likely game update).                 |
| `seeding-after-restart` | Still below `SEEDING_BELOW` for `SEEDING_MINUTES` (30), counted from the later of the low episode's start and a restart or recovery within `SEEDING_AFTER_RESTART_HOURS` (12). Once per episode.                                                                                                                                                                                                                                                                                                                                                                                        | warning (no ping)                                        | **Still empty 30 min after the 04:00 ET restart**                                                  |
| `seeding-prime`         | Still low for `SEEDING_MINUTES` inside `SEEDING_PRIME_HOURS` (17:00-23:00 local). Once per episode per window date.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | high (may ping)                                          | **Still empty 30 min into prime time**                                                             |
| `seeding-recovered`     | The episode ends (5 minutes in a row not low), only if a seeding alert was raised.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | info                                                     | **Players are back** · 12 players on after 10 h 23 min below 1.                                    |
| `performance-window`    | `WINDOW_KILLS` (30) or more kills within `WINDOW_MINUTES` (5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | warning (never pings)                                    | **Review: unusual kill rate** · Ace had 31 kills in 5 min (6.2/min).                               |
| `performance-match`     | `MATCH_KILLS` (40) or more round kills at K/D `MATCH_KD` (20) or more.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | warning (never pings)                                    | **Review: unusual round K/D** · Ace has 44 kills and 2 deaths this round on Bakurani (K/D 22).     |
| `watchlist-join`        | A watch-list player appears who was not online in recent reads, including right after a failed read, an outage or a map load. One per player per `WATCHLIST_COOLDOWN_MINUTES` (360). Players already online when Gramps starts are recorded only (section 5).                                                                                                                                                                                                                                                                                                                           | high at `WATCHLIST_HIGHLIGHT_COMMUNITIES`+, else warning | **Watch list: player joined** · Banned in 4 communities (as recorded 2026-10-02). Monitoring only. |

Every seeding alert adds: "Gramps reads the player count over RCON. It cannot see whether the server is listed in the browser. Check the in-game browser and consider a seed call."

**Quiet by design.** One alert per episode, a recovery message only if an alert was sent, no reminders. Per server and rolling hour: health and seeding together 6, watch list 6, performance `PERFORMANCE_MAX_PER_HOUR` (3). At most one role ping every 30 minutes. Alerts held back by a limit, a cooldown or a snooze are still recorded, with the reason, for the dashboard. Reads never wait for Discord to accept a post; while 10 posts for a server are still waiting on Discord, further alerts are recorded only, with that reason. A scheduled restart below the player threshold and a watch-list player already online when Gramps starts are recorded only; neither posts, pings or uses up a limit (hourly or the 30-minute restart limit).

**Embeds.** Grey for info, amber for warning, red for high. The footer reads `Gramps · <server> · alert <id>`. Player names are game-controlled: control characters are removed, Markdown is escaped, mentions are neutralized and names are capped at 64 characters. SteamIDs are shown as code. There is no "Open in dashboard" button yet: it arrives with the dashboard's Staff alerts tab. Until then, use the alert ID in the footer with the staff API (section 7).

### The October 2 incident, replayed

Bulkhead's hotfix restarted the server at 08:00 UTC (04:00 EDT). It then sat at 0 players from 04:37 to about 15:00 EDT and dropped out of most players' browser views, and nobody noticed for hours. With the defaults, Gramps would post a `game-restart` at about 04:03, one "Still empty 30 min after the 04:00 ET restart" at 05:07, and "Players are back" at about 15:05. No prime-time alert fires, because players returned before 17:00. A `game-down` is added only if RCON stays unreachable for 10 minutes, and `game-build` only if the build string changed. A test encodes this timeline.

## 4. Performance thresholds and calibration

| Rule       | WarDogs (as observed)                 | Gramps default                                                      | Why                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Burst      | 15+ kills in 5 min at 4.0/min or more | **30 kills in 5 min (6.0/min)**                                     | The WarDogs rule produced 58 alerts from Sep 30 to Oct 2, mostly our own regulars. WarDogs' v0.39 notes put the best player on a busy server at about 0.6 kills/min over a match; 6/min flagged nobody in their 30-day sample. 30 in 5 min is about ten times that. |
| Match      | 15+ kills and K/D 10+                 | **40+ round kills and K/D 20+**                                     | The owner (UncDap) was flagged twice at K/D 16, and [UNCs] members were flagged too. K/D 20 sits above that regular peak; 40 kills removes short, streaky rounds where one death swings the ratio.                                                                  |
| Repeats    | One per player per match              | **One per player per round, a 6 h per-player cooldown, 3 per hour** | Consecutive rounds by the same strong regular were the main repeat noise.                                                                                                                                                                                           |
| Known good | "Legit, never flag again" button      | **Env allow-list, plus a session "Never flag" until restart**       | Avoids a schema change.                                                                                                                                                                                                                                             |

How counting works:

- Only the `/v1/players` `kills` and `deaths` counters are used. If no row has kills, the status shows `counters: "unavailable"` and nothing is flagged. Rows without a SteamID are excluded and counted as `unlinkedPlayers`.
- Counts start when Gramps first sees a player in a round, so a Gramps restart mid-round under-counts (fewer alerts), and a first observation never alerts.
- The game reports no round ID, so Gramps infers rounds from status reads: a map or rotation change, a match clock that runs backwards, or a complete or large score reset. A score reset and map travel before anyone scores are one round. A read without usable team scores leaves the round phase unknown.
- A player's counter drop (rejoin) keeps the round totals. Most players' counters dropping at once, or a restart-like boundary, starts a new local round. A read gap over 60 seconds restarts every rate window. Nothing is evaluated while the round phase is unknown.
- The combat feed is never used by the rules. While it is delivering (a batch in the last 10 minutes), an alert also carries the player's feed kills, headshot share, top two causes and longest distance from at most 500 recent events, as supporting context only. Follow [Combat history](COMBAT_HISTORY.md#later-moderation-assistance): show the supporting events, allow dismissal, never present them as proof.

Caveats: without headshot data these are conservative starting points, and explosives and vehicle multi-kills can still trip the window rule.

**Calibrate first.** `STAFF_ALERTS_PERFORMANCE_ENABLED=observe` tracks players and records alerts for the dashboard without posting. The status `peaks` keep, for the last 20 rounds, the highest window kills and the highest round K/D (among players with at least 10 kills). Run one week in `observe`, compare the peaks and recorded alerts with the WarDogs alerts, then switch to `true`. Lower thresholds only from that evidence.

## 5. Known-good list and watch list

Both are JSON env values. Adding or removing an entry means a redeploy. The staff API shows only how many entries there are.

The watch list is checked only while `STAFF_ALERTS_ENABLED=true` and `STAFF_ALERTS_WATCHLIST_ENABLED=true` (section 2). With either flag off, the `STAFF_ALERTS_WATCHLIST` entries are still validated at boot but never looked up, and `features.watchlist` in the staff status is `false`.

```
STAFF_ALERTS_PERFORMANCE_KNOWN_GOOD='["76561198000000001",{"steamId":"76561198000000002","note":"owner"}]'
STAFF_ALERTS_WATCHLIST='[{"steamId":"76561198000000003","reason":"Aimbot","evidenceUrl":"https://example.com/clip","communities":4,"recordedAt":"2026-10-02","addedBy":"Dennis"}]'
```

- Known-good: personal SteamID64 strings or `{"steamId","note"}` (note up to 80 characters), at most 500, each SteamID once, and at most 65,536 characters for the whole value. That fits 500 entries with full 80-character notes, as **Never flag** returns them. They are never flagged for performance. When a moderator chooses **Never flag**, the response includes the exact entry to paste here so it survives a restart.
- Watch list: at most 200 entries, each SteamID once, and at most 65,536 characters for the whole value. That is about 325 characters per entry across 200 entries, so long reasons and evidence links reach the character limit first (200 entries with a 120-character reason and a Discord message link do not fit); Gramps refuses to start when the value is too long. `reason` (1-200 characters, one line) is required. `evidenceUrl` must be an `https://` link without credentials, spaces, `<`, `>` or backticks, which the alert could not show; Gramps trims it, keeps it in its normalised form (`HTTPS://` becomes `https://`) and refuses to start when it does not qualify. `communities` (1-999), `recordedAt` (`YYYY-MM-DD`), `addedBy` (up to 64) and `source` (`wardogs-network` by default, or `staff`) are optional. Copy entries by hand from the WarDogs network alerts in the private channel.
- Watch-list matches are **monitoring only**. They alert when a listed player appears who was not online in recent reads, which includes joins across a failed read, an outage or a map load. A player who stays online through those is not looked up again, unless no good read lists them for 30 minutes (a longer outage). A roster that stays empty for longer than a map load (3 minutes) means everyone left, so a listed player who was last online before the server emptied alerts again when they come back, subject to the cooldown.
- Everyone online when Gramps starts is checked once and recorded for the staff API as "online when Gramps started", without posting or pinging. Gramps keeps no state across restarts, so posting them would repeat alerts staff already had on every redeploy and every watch-list edit. If Gramps starts during a map load (an empty roster), the roster refills over several reads, so every player listed within the first 3 minutes counts as online at the start. On a server that really was empty, a watch-list join in those 3 minutes is recorded the same way. If such a player leaves and joins again, that join alerts as usual.
- A known-good player on the watch list still alerts, with a note.

## 6. Limits of inference

Gramps cannot see uptime, a boot ID, CPU or memory, tick rate, server load, or whether the server is listed in the in-game browser. Restarts, updates and seeding problems are inferred from RCON reads and say so. "Server under load" alerts from WarDogs have no Gramps equivalent. A restart while the server is empty may not be detected. The match clock or map changing across a read gap or a longer outage is treated as a restart signal. A single failed read is often just the game hitching during map travel, so across one failed read (within a minute of the reads on either side, however long that read took to time out) a new map, clock or round is not a restart signal, and an empty roster has to stay empty for 3 minutes first.

The default `SEEDING_AFTER_RESTART_HOURS=12` also fires after a quiet overnight restart that leaves the server empty; set it to `0` if that is unwanted and rely on the prime-time window. Leave `STAFF_ALERTS_HEALTH_SCHEDULED_RESTARTS` empty until the actual daily restart time is known; the host's schedule is currently unverified (see [Admin dashboard](ADMIN_DASHBOARD.md#current-delivery-status)).

## 7. Reviewing alerts and acting

- **Staff API.** `GET admin/api/staff-alerts` (single server) or `GET admin/api/servers/<id>/staff-alerts` returns the status: features, channel and ping state, thresholds and list counts, worker observations (connection, players, round, build, last restart, seeding episode, counters, tracked and unlinked players, source errors), active snoozes, the newest 100 alerts and per-round peaks. Any staff role with access to the server can read it.
- **Review.** `POST .../staff-alerts/<alertId>/review` with `{"decision":"ack"|"legit"|"never"}`. Moderators and administrators only. `legit` and `never` apply to performance alerts. `never` suppresses that SteamID until Gramps restarts and returns `knownGoodEntry`. The reviewer and time are kept in memory, and the Discord footer is updated when possible ("Marked legit by Mod One").
- **Snooze.** `POST .../staff-alerts/snooze` with `{"category":"health"|"seeding"|"performance"|"watchlist"|"all","minutes":15-1440}`; `0` clears it. Snoozed alerts, including recovery messages, are still recorded. Snoozes do not survive a restart.
- **Kick or ban.** Use the existing dashboard actions on the player, which go through `AdminService.act` with your identity, a reason and (for a ban) the typed SteamID confirmation. Current game builds reject bans for offline players with `player_not_found`, so a ban works only while the player is connected. Gramps never queues a ban to apply later.

The dashboard's Staff alerts tab (Activity → Staff alerts) is planned to land after the dashboard refresh. Until then, use Discord and the staff API.

## 8. What a future network-ban API would need

The research found no usable, permitted WarDogs API. The partner API (`wdp_`) returns server status by join code with no ban data; the community API (`wdk_`) has `/bans` for our own bans only, with undocumented response shapes; "Banned in N communities" appears only in the WarDogs Discord alert; the Hall of Shame endpoint is undocumented. Gramps therefore does no remote lookup and adds no key settings. `NetworkBanSource` (`src/staff-alerts/network-bans.ts`) is the extension point.

Before any remote source, get in writing from the WarDogs team:

1. A documented endpoint that takes a SteamID64 and returns confirmed, active network bans: community count, reasons, evidence URLs, a revoked flag and `updatedAt`.
2. A read-only key type issued to The UNCs. Never a `wdk_` key with `moderate`, `control` or `config` scopes.
3. Written permission to use and cache the data for staff alerts.
4. The rate limit.
5. Confirmation that no game server has to be linked on their side.

A `RemoteNetworkBanSource` would then use the reserved names `STAFF_ALERTS_NETWORK_LOOKUP_URL` and `STAFF_ALERTS_NETWORK_LOOKUP_KEY` (not added now); look a player up only on first appearance in 24 hours; keep an LRU cache of 5,000 entries (positive 24 h, negative 6 h); make at most 20 calls a minute; time out after 3 seconds and pause 15 minutes after 5 failures in a row; never log the key, send it to the browser or post it; clean response text before display; and never ban automatically.

## 9. Appendix: owner steps on the WarDogs side

These are steps in WarDogs Server Commands and Warcon, not Gramps code. They keep the game server **disconnected** and leave the bot in Discord only for network-ban alerts.

**Disconnect the game server.**

- In WarDogs Server Commands, remove every server under ST-00.
- In Warcon, revoke the WarDogs key. If the WarDogs agent was used, stop and remove it.
- Change the RCON password, because WarDogs was linked by direct RCON with our password. Set the new password in the server configuration on the host (xREALM) first, then update `WARDOGS_RCON_PASSWORD` (or the server's `password` in `WARDOGS_SERVERS`) on Railway.
- Then rotate the `[WDServerFeed]` token, since a bot with RCON or config access could have read it. Set a new token in the server configuration on the host (xREALM) first, then update `WARDOGS_FEED_TOKEN` (or the server's `feedToken` in `WARDOGS_SERVERS`) on Railway.
- Check the Warcon organisation ban list and the whitelist for entries WarDogs added, and decide on each one.
- Never re-add the server: held bans and whitelist grants can run automatically on reconnect.

**Keep only network alerts.**

- ST-06: turn on "Receive network alerts", point it at the private staff channel, and turn **off** "Share bans with the network".
- Turn off ST-07 (suspicious performance) so alerts are not duplicated, and the ST-13 auto-kick; turn on Watch mode.
- ST-02: remove ban and unban rights from every role, and turn on "Admins follow these roles too" (or use the ST-28 staff checks), so nobody can press "Ban here too".

**Confirm delivery.** Ask in the WarDogs support Discord whether ST-06 alerts reach a community with zero linked servers (a v0.8 fix suggests they might not), then watch the channel for a few days. If no alerts arrive, staff raise it with the owner. The server stays unlinked either way.

Gramps does not read those WarDogs messages. Staff copy what matters into `STAFF_ALERTS_WATCHLIST`, which Gramps checks only while `STAFF_ALERTS_WATCHLIST_ENABLED=true` (section 2).
