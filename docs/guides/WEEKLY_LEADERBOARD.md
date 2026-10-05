# Weekly Discord leaderboard post

Gramps can post one friendly leaderboard message per configured game server per week to one Discord channel. It shows the top 5 by kills with K/D, up to five data-backed shout-outs, and a link to https://theuncsgaming.com/leaderboard. It is off by default and stays silent whenever there is no data or too little.

It uses only stored combat history ([Combat history and server leaderboard](COMBAT_HISTORY.md)): `killed` events with their weapon/cause, distance, headshot flag and map. There is no schema change and no migration.

Not included, because the data does not exist:

- **Money made, live kills and deaths:** `/v1/players` cash, kills and deaths are live per-round values that are never stored.
- **Logistics and recon:** the feed stores no such events.
- **Per-match results:** `matchId` was reused across map changes, so there is no "best match".
- **Accuracy:** shots and hits are unavailable. Headshots are counted, never shown as a share.

## Configuration

| Setting                          | Default  | Notes                                                                                                                   |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `WEEKLY_LEADERBOARD_ENABLED`     | `false`  | Turns on the automatic post and the staff post-now. Preview works either way.                                           |
| `WEEKLY_LEADERBOARD_CHANNEL_ID`  | none     | A text or announcement channel in `ADMIN_GUILD_ID`. The bot needs View Channel, Send Messages and Read Message History. |
| `WEEKLY_LEADERBOARD_DAY`         | `sunday` | Lowercase weekday.                                                                                                      |
| `WEEKLY_LEADERBOARD_TIME`        | `20:00`  | `HH:MM`, 24-hour, New York time. 01:00–02:59 is refused so a DST change can never skip or repeat a slot.                |
| `WEEKLY_LEADERBOARD_MIN_KILLS`   | `100`    | Kills in the week (1–100,000).                                                                                          |
| `WEEKLY_LEADERBOARD_MIN_PLAYERS` | `10`     | Players with a kill or a death in the week (5–1,000).                                                                   |

Fixed in code (`src/weekly-leaderboard/`):

- Time zone `America/New_York`, not configurable.
- `CATCH_UP_HOURS = 6`: a slot is acted on only within six hours.
- `TOP_N = 5` and `MIN_RANKED_PLAYERS = 5` (players with at least one kill).
- The shout-out minimums below (`SHOUT_OUT_RULES`).

## Week and schedule

- **Slot:** the configured day and time as New York wall-clock time. With the defaults, Sunday 20:00 ET, which is Monday 00:00 UTC in daylight time and 01:00 UTC in standard time.
- **Week:** from the previous slot up to the slot, measured on receipt time like the website's rolling periods. A week spanning a DST change is 167 or 169 hours. Both queries use `since` = previous slot and `until` = slot − 1 ms (the store treats `until` as inclusive), so totals and shout-outs always agree.
- **Week key:** the ISO year and week of the slot's New York date, for example `2026-W40` for Sunday, October 4, 2026. The posted check only reads the channel from the current slot onward, so change `WEEKLY_LEADERBOARD_DAY` right after a post; moving the day earlier within a week that was already posted can post that week again.
- **First possible post:** Sunday, October 4, 2026, 20:00 EDT, covering from 2026-09-28 00:00 UTC.
- **Worker:** checks shortly after startup (60 seconds) and then every five minutes, for each configured server. It acts only within six hours after the slot. Turning the feature on midweek or deploying on a Wednesday never causes a surprise post; that week is recorded as `missed posting window`, and an administrator can still post it. Turning it on within six hours after a slot does post the week that slot closed; see [Before turning it on](#before-turning-it-on).

## Skipping silently

Checks run in this order and the first failure is recorded as the reason. A skip sends nothing to Discord.

1. `WEEKLY_LEADERBOARD_ENABLED=false` → `disabled`
2. No channel, or no `ADMIN_GUILD_ID` → `channel not configured`
3. The server's game feed is off or has no usable token → `feed not configured`
4. No batch received since the week started → `no combat events received this week`
5. Too few kills → for example `below minimum kills (37/100)`
6. Too few players → for example `below minimum players (6/10)`
7. Fewer than 5 players with kills → `fewer than 5 players with kills`
8. A database error → `storage unavailable`, retried on the next check

While the game's combat feed is not delivering, every week stops at step 4 and nothing is posted.

## What the post says

```
**The UNCs · Weekly board** · week ending Sun, Oct 4
Good games, older knees. Here's how the week shook out.

**Top 5 by kills**
1. Grandpa Joe — 87 kills · K/D 2.35
2. NapTime — 74 kills · K/D 1.90
3. Unnamed player — 61 kills · K/D 1.22
4. LowerBack — 58 kills · K/D 3.41
5. Reading Glasses — 52 kills · K/D 0.96

**This week's shout-outs**
Still got it: LowerBack, K/D 3.41 over 58 kills
Reading glasses not required: NapTime, 21 headshot kills
Long-distance call: Reading Glasses, 412 m with M1 Garand on Zestafona
Old faithful: M1 Garand, 304 kills
Where the knees hurt most: Zestafona, 512 kills

Stretch, hydrate, run it back. Full board: https://theuncsgaming.com/leaderboard
-# Counted from game events Gramps received <t:…:f> – <t:…:f>; delayed or missing deliveries aren't included. Weekly board 2026-W40 · The UNCs [primary]
```

(Invented example data.) With more than one configured server the heading also names the server. If tracking started partway through the week, a `-# Counting since <t:…:f>` line is added above the last line.

**Names.** Every name, including shout-out names, goes through the public names-only rule and then the website's stricter one: a name that is empty, is a SteamID, contains the player's SteamID or contains any run of 17 digits becomes "Unnamed player". `plainLabel` then removes mentions, markdown, links and line breaks and shortens the name to 32 characters; anything left empty becomes "Unnamed player". `xX_Sniper_Xx` shows as `xX Sniper Xx`, as with other game labels in Discord. No SteamID ever reaches the message.

**Top 5.** The store's order: kills, then fewer deaths. K/D has two decimals, or a dash with no deaths.

**Shout-outs.** A kill is a non-suicide event with a linked killer. Each line appears only when its minimum is met; the section is left out when none qualify.

| Label                        | Rule                                                         | Shown only if                                                                                            |
| ---------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Still got it                 | Best `kills / max(deaths, 1)`, then more kills               | Among players with at least 10 kills                                                                     |
| Reading glasses not required | Most headshot kills                                          | At least 3                                                                                               |
| Long-distance call           | Longest single firearm kill; the earliest wins a tie         | 10–2,000 m. Above 2,000 m the line is left out, because the source's distance units are not yet verified |
| Old faithful                 | Most-used weapon/cause across all kills                      | A cause on at least half of the kills, at least 5 uses, and a readable name                              |
| Where the knees hurt most    | Map with the most kills (catalog ID and in-game name merged) | Kills on at least 2 maps, and at least 5 on the top map                                                  |

The longest kill counts infantry weapons only: artillery, rocket pods, vehicle guns, explosives, melee and tools never take the long-distance call, by the same [long-shot rule](COMBAT_HISTORY.md#long-shots) as the website's longest kills.

Weapons use the shared labels in `src/common/cause-labels.ts`, the same ones as the website's server stats and the staff dashboard. `Id.Item.AK74M` and `ID.Item.AK74M` both read "AK-74M", and Old faithful counts them together. Unnamed codes get a tidy generic name, such as "Weapon 029" for `WEPN_029`. A cause the labels cannot name (an unknown dotted id, a path, a `BP_` prefix or `_C` suffix, or anything SteamID-like) is never shown, raw or otherwise; the line simply leaves the weapon out. Team kills are not excluded, because no team-kill tag has been observed yet; add an exclusion once the first real batch shows one.

**Copy rules.** Banter only. The post never mentions rewards, prizes, points, the whitelist or queue priority, and the word "free" is not used. Nothing is offered for placing, so a place on the board can never read as earning whitelist access. A test (`weekly-render.spec.ts`) enforces this on the template text.

**Delivery.** No pings: `allowedMentions` is empty. Link previews are suppressed. The content is at most 2,000 characters, and the last line carries the marker `Weekly board <week key> · <server name> [<server id>]`. The name is for readers; the posted check matches the week and the server ID, because server names need not be unique and two names can read the same once shortened for Discord.

## Posting once

- **Channel check:** a text or announcement channel (never crossposted) in `ADMIN_GUILD_ID` with View Channel, Send Messages and Read Message History. Otherwise `channel unusable`, or `Discord not ready` before the bot connects; both are checked again on the next pass.
- **Posted check:** the bot reads the channel from the slot forward, up to five pages of 100 messages. The week counts as posted if one of the bot's own messages ends with this week's marker for this server ID (`already posted`), whatever server name it shows. With more history than that, or a failed read, the answer is `posted check unavailable` and nothing is sent: when in doubt, Gramps does not post. The bot can read its own messages without the privileged message content intent.
- **Claim and send:** the week is claimed in memory immediately before the single send. The send uses a deterministic nonce (`sha256("weekly-leaderboard:<serverId>:<weekKey>")`, first 24 hex characters) with `enforceNonce`, so a second process sending the same week within Discord's nonce window gets the first message back.
- **Outcomes:** `posted` with the message ID; `failed` when Discord definitely refused it (a 4xx such as 50013 Missing Permissions); `unknown` after a timeout or network error. The schedule never retries an unknown or failed send in that process. After a failed send nothing was posted, so an administrator can post that week once the cause is fixed; after an unknown send they cannot. A threshold skip also settles the week.

Why no database claim: after a restart inside the window the channel scan finds an earlier post; the nonce covers two processes overlapping during a rolling deploy; and `SERVER_COMMUNITY.md` already requires one Gramps instance. A claim row in `admin_actions` was rejected because that table is the staff and game action log, and a weekly-post row would need audit and dashboard changes.

Remaining risks:

- Two long-running instances could each post outside Discord's nonce window.
- Changing a server's `id` during a week defeats the marker match for that week. Renaming its display name does not.
- Deleting the bot's post by hand and restarting Gramps inside the window posts it again.
- The schedule never retries a `failed` or `unknown` send in that process. After `failed` nothing was posted, so an administrator can post-now in the same process once the cause is fixed; no restart is needed. After `unknown`, post-now is refused until a restart. Then the channel scan decides: within the window the worker posts only if no earlier post is found; after it, an administrator can post-now.

## Staff routes

All routes use the staff session guards. Results are kept in memory per server and reset on restart, like feed delivery diagnostics, and never contain names or SteamIDs. Each skip or failure is logged once per server, week and reason; nothing about it is posted to Discord.

- `GET /admin/api/weekly-leaderboard` and `GET /admin/api/servers/:serverId/weekly-leaderboard` (any staff role): `enabled`, `configured`, `feedConfigured`, `schedule` (`day`, `time`, `timeZone`, `nextPostAt`, `catchUpHours`), `thresholds` and `lastRun` (`weekKey`, window, `checkedAt`, `trigger`, `outcome`, `reason`, `totals`, `messageId`).
- `GET /admin/api/servers/:serverId/weekly-leaderboard/preview?week=last|current` (administrators only; others get 403 "Only administrators can preview or post the weekly board."): never sends. `last` (default) is the last completed week, which can be posted; `current` is the week so far, preview only. Returns `weekKey`, the window, `postable`, `eligible`, `reason` (checks 2–8 above; the on/off switch is reflected in `postable`), `totals`, the rendered `content` (even when ineligible), `previewHash` (sha256 of the content) and `alreadyPosted` (`null` when the channel cannot be checked).
- `POST /admin/api/servers/:serverId/weekly-leaderboard/post` (administrators only, with the dashboard's Origin, CSRF token and server version): body `{ "weekKey", "previewHash", "confirm": true }`, nothing else. Refused with 409 unless the feature is on, `weekKey` is the last completed week, the week is eligible (no threshold override), it was not already handled or posted, and a fresh render matches the preview hash ("The board changed since your preview. Preview again."). Discord and channel problems return 503. It uses the same claim, channel scan and nonce as the schedule, records `trigger: "staff"`, logs the staff ID and returns `{ outcome, messageId, weekKey }`.

The dashboard has no page for these routes yet.

## Before turning it on

1. Native feed delivery is observed after genuine combat, per the acceptance check in [Combat history](COMBAT_HISTORY.md#retention-and-connection).
2. The names-only website is live in production (see the release order in the combat history guide).
3. The first real batch is checked for `cause` and `mapName` values, distance units and any team-kill tag; adjust the label tables in `src/common/cause-labels.ts`, the distance cap or add a team-kill exclusion. As of October 5 the causes seen live all have labels; CGM4 ("Carl Gustaf M4"), SR_04, the `WEPN_0xx` codes, ROT_04 and WHL_05 still want an in-game check.
4. The owner approves the labels and copy above.

Then set `WEEKLY_LEADERBOARD_CHANNEL_ID`, leave `WEEKLY_LEADERBOARD_ENABLED=false`, and restart. Preview the week that will post next and check the rendered board, `eligible` and `reason`; preview does not need the feature on, and `postable` stays false until it is. Before the first slot, or when turning it on outside the catch-up window below, that is `preview?week=current`: the week so far, which posts at the next slot, so `eligible` can still change before then. Run `preview?week=last` only when turning it on inside the window, where it is the week that posts about a minute after the restart. When the preview looks right, set `WEEKLY_LEADERBOARD_ENABLED=true` and restart.

**Mind the six-hour catch-up window.** The worker checks about a minute after startup and acts on a slot for six hours after it. Turning the feature on in that window (with the defaults, Sunday 20:00 to Monday 02:00 ET) posts the week that just closed about a minute after the restart, as long as it clears the thresholds and the channel has no earlier post for it. Preview first, or turn it on outside that window.
