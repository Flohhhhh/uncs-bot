# Combat history and server leaderboard

The optional Wardogs feed stores combat events for this server and exposes rolling 24-hour, 7-day and 30-day views. The public website leaderboard contains game display names, recorded kills/deaths, headshot kills and K/D, plus optional row extras (go-to weapon, longest kill, best streak), never SteamID64s; a missing name, or a name that is or contains any 17-digit run (a SteamID, its own or another player's), becomes "Unnamed player". Public [server stats](#public-server-stats) add server-wide totals, weapons, maps, long shots, busy hours and fun-kill counts under the same rules. Authenticated staff rankings keep SteamID64s for moderation and player history. Authenticated staff can inspect the recent killfeed and a selected player's events. Application emails, Discord account details and application review notes are never joined into this data.

This is recorded game history for human review, not an anti-cheat verdict. There are no automatic bans, cheat scores, or automatic accusation messages.

## Sources and limits

The implemented payload follows the [Warcon author's captured game traffic](https://github.com/warcon-app/warcon/blob/main/docs/wardogs-api.md#serversettingsini-keys-the-server-honours) and [feed parser](https://github.com/warcon-app/warcon/blob/main/src/lib/server/feed-core.ts). The UNCs host and Gramps receiver are configured, but the first native batch has not been observed or sampled. The current official downloadable reference ini does not document a full feed schema; do not claim the observed schema is a published anti-cheat API.

Observed killed events include event IDs, game clock, map, killer/victim names and Steam IDs, cause/weapon, optional distance and context tags. Distance is stored in the source's centimetres and displayed in metres. Environmental deaths may lack a killer; explosions and suicides can lack distance. Invalid or absent Steam IDs are unlinked actors, not invented identities.

- Count a death for a linked victim. A suicide never earns a kill or headshot kill.
- K/D is undefined when there are no recorded deaths; display a dash.
- Headshot counts represent observed headshot kills. A share of kills is not shooting accuracy: misses and all shots/hits are unavailable.
- The feed does not establish aim movement, player positions, line of sight, recoil, faction membership at the instant of a kill, or confirmed cheating. Do not infer these fields.
- Receipt time in UTC determines the rolling windows. The source game clock is retained separately. Delayed batches must not be interpreted as simultaneous kills.
- Captured builds reused `matchId` across map changes. It is not a verified round boundary, so no per-round totals are advertised.
- Missing deliveries and history before capture are not reconstructed. A quiet feed can mean no deaths occurred and is not proof the server is offline.

## Ingest and access

`WARDOGS_FEED_ENABLED=false` by default. `WARDOGS_FEED_TOKEN` is a separate random feed-only secret, at least 32 characters, and must differ from the RCON password. It is never sent to player browsers. Once `WARDOGS_SERVERS` is set, `WARDOGS_FEED_TOKEN` is ignored and each registry entry's `feedToken` is used instead, so move the existing token into the `primary` entry.

The game POSTs batches to `POST /api/ingest/events` using `Authorization: Bearer <feed token>`. The configured token determines the authorized server; the incoming `serverId` is only a per-boot instance identifier. With `WARDOGS_SERVERS` set, this unscoped route still works: the bearer token is compared in constant time with every entry's `feedToken`, and the batch, its refusals and its rate limit belong to the one server whose token matches exactly. A request that matches no entry is refused with 400 `server not selected`. `/api/ingest/servers/ID/events` also accepts that server's token. Payload size, batch length, numbers and strings are bounded. Other event types are not stored one by one; they are counted per type and day (see [Game event types](#game-event-types)). A malformed killed event, an entry without a string `type`, an entry whose `type` is not a bounded name or a non-object entry is skipped and counted as invalid, so one odd event cannot discard the batch; a malformed envelope (`serverId`, `serverName`, `events`, the 64 KiB or 200-event cap) still rejects it. A batch with no valid entry of any type and a malformed entry is also rejected with 400 (`invalid payload: <first malformed location>`), so a feed whose every event is malformed never reads as receiving. A badly named type alone never rejects a batch, and a batch with any valid entry or with nothing invalid, even an empty one, is accepted; its invalid entries show in `lastBatch`. Event, match and server IDs accept any 8-4-4-4-12 hexadecimal GUID, in either case, and are stored lowercase; PostgreSQL `uuid` columns do not require RFC 4122 version bits. Unexpected errors do not return raw payloads, database strings or credentials. Requests carrying the targeted server's feed token are limited to 300 a minute per server. Requests without it have their own per-address limit, so they cannot use up the game's allowance.

Refused deliveries are recorded in memory per server and shown only in the staff combat response and on the staff combat page. Each refusal keeps `at`, HTTP `status` and a short `reason` such as `feed disabled`, `token mismatch`, `invalid payload: serverId (bad format)`, `too large`, `invalid JSON`, `rate limited` or `storage unavailable`. Refusals of requests that carried the server's feed token, which only the game should have, are `lastRejected` and `rejectedCount`. All others, such as missing or wrong credentials, a feed token that is not configured, or malformed JSON, oversized bodies and rate limiting without the token, are `lastRejectedWithoutToken` and `rejectedWithoutTokenCount`. Anyone can reach the ingest URL, so those prove only that a request arrived and cannot replace the game's own record; repeated `token mismatch` refusals can still mean the game uses the wrong token. `lastBatch` holds the last stored batch: `at`, `accepted` valid killed events including repeats, `skipped` (other event types plus invalid entries), `invalid`, the schema location of the `firstInvalid` entry, `types` (distinct valid event types in the batch) and `typesOverLimit` (new types not counted because of the daily limit). Tokens, headers, bodies and addresses are never kept; the Authorization header is only compared with the feed token. Each refusal, and each batch with invalid entries, also logs a warning. Warnings are limited to one per minute for each server, token state, HTTP status and reason category, with a count of the suppressed ones, so refusals without the token cannot hide the game's. The record resets when Gramps restarts.

Events are stored transactionally with a unique instance/event ID pair so repeat deliveries cannot inflate retained statistics. Aggregation occurs in PostgreSQL. The public leaderboard returns the top 100, while aggregate totals cover all recorded players. Staff event views return the latest 100 events in the selected window; older events within retention remain included in aggregates.

### Game event types

Only killed events are stored one by one. So staff can learn what else the game sends without storing it all, every valid event type in an accepted batch is counted in `game_feed_event_types`: one row per configured server, type and UTC receipt day, with a running count, first and last receipt time and one sample, the latest entry of that type. Nothing else is stored per event, so the table grows by a handful of rows a day, not by events.

- Killed events are counted too, so staff see the whole mix, but keep no sample.
- A sample is the entry made storable, at most 4 KiB of JSON as stored. A larger entry is still counted and keeps the earlier sample, or `{"tooLarge": true, "bytes": n}` when there is none. NUL characters and unpaired surrogates are removed, and numbers JSON writes with an exponent, such as `1e+308`, are kept as text. IP addresses in keys and strings become `[IP address removed]`: whole values, address-like words with a port or zone, and IPv4 addresses inside text. This is best effort, not a guarantee. Samples can contain SteamIDs and player names, the same kind of data as stored killed events.
- A type is a letter followed by up to 63 letters, digits, `_`, `.`, `:` or `-`. Any other string is an invalid entry.
- At most 200 new types per server and UTC day are counted, killed aside, so a faulty feed cannot add unbounded rows. Types over the limit show in `lastBatch.typesOverLimit` and log a warning with counts only, never type names or payloads.
- Counts are written with the killed events in one transaction, in one statement per batch. Repeat deliveries count again, since nothing per event is kept to detect them: treat counts as a guide, not exact totals.
- Staff only: `otherEvents` in `GET /admin/api/combat` lists each type in the window with its total, first and last receipt and latest sample, and the staff combat page shows them under **Game events received**. The window is rounded out to whole UTC days. Public `/community/api` routes and the weekly post never include them. Samples are never logged.
- Rows are purged after 90 days by the daily cleanup below.

The table must exist before code that writes it is deployed: counts share the killed events' transaction, so without it every batch fails as `storage unavailable`. If the counts cannot be read, the staff combat page still loads without them and Gramps logs a warning.

Routes:

- `GET /community/api/leaderboard?period=day|week|month`: public game statistics only, without SteamIDs.
- `GET /community/api/stats?period=day|week|month` and `GET /community/api/servers/:serverId/stats?period=...`: public server stats, without SteamIDs. See [Public server stats](#public-server-stats).
- `GET /admin/api/combat?period=...`: authenticated staff history, including the event type counts above.
- `GET /admin/api/combat/players/:steamId?period=...`: authenticated staff player history.

### Weapon labels

The game reports causes such as `Id.Item.AK74M`, `ID.Item.AK74M` (both casings occur), `Vehicle.Variant.Air.Rotary.ROT_04.Default` and `Id.Vehicle.WeaponExtension.WHL_05.RingTurret`. `describeCause()` in `src/common/cause-labels.ts` turns each into a readable label and a kind (`firearm`, `explosive`, `melee`, `vehicle`, `vehicle_weapon`, `tool`, `environment` or `unknown`): "AK-74M", "ROT-04 helicopter", "Ring turret". It ignores prefix casing, so both AK spellings are one weapon everywhere. Unnamed codes get a tidy generic name, such as "Weapon 029" for `WEPN_029`. A cause it cannot name (an unknown dotted id, a path, a blueprint name, or anything with a 17-digit run) reads as "Unknown weapon", never the raw id. Every label is at most 40 characters of letters, digits, spaces, `'` and `-`, and never contains the word "free". The public stats, the weekly Discord post and the staff dashboard all use it; staff still see and can search the raw cause, and can search the label too. The staff weapon filter has one option per label, so both AK spellings filter together; each cause with no name gets its own "Unknown weapon (raw id)" option.

To name a new item, add it to the tables in that file with a test. As of October 5, CGM4 is assumed to be a Carl Gustaf launcher ("Carl Gustaf M4"; use "CGM4" if that is wrong), and SR_04, the `WEPN_0xx` codes, ROT_04 and WHL_05 keep generic names until someone checks them in game.

### Leaderboard row extras

Each public leaderboard row can also carry these optional fields. Each is omitted, never null, when it is unknown:

- `topWeapon`: the label of the player's most-used weapon in the window, by kills. "Unknown weapon" is never chosen; ties go to the alphabetically first label.
- `longestKillMeters`: the player's longest kill in whole metres, within the 2 km public cap.
- `bestStreak`: the most kills in a row without dying, at least 1. It is counted within one game server session (`server_instance_id`) in receipt order, then game clock order, so it resets when the game server restarts and is approximate across delivery gaps. A self-inflicted death ends a streak. At an exact tie the kill counts before the death.

They are read for the 100 listed players only, through the killer and victim indexes, in one read-only transaction (`TelemetryStore.rowExtras`). The result is cached for 60 seconds per server and period, separately from the 10-second leaderboard snapshot, and feed batches do not clear it. A player who enters the top 100 after the cache was filled gets extras at the next refresh. If the read fails, Gramps logs "Leaderboard extras unavailable; serving rows without them." and serves the rows as before: the leaderboard never fails because of extras. Staff rankings and player history are unchanged.

### Public server stats

`GET /community/api/stats` (or `/community/api/servers/:serverId/stats`) returns the leaderboard's metadata (`serverId`, `enabled`, `connected`, `feedStatus`, `lastReceivedAt`, `trackingStartedAt`, `period`, `windowStartedAt`, `asOf`, `coverageNote`) and:

| Field          | What it holds                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `totals`       | `events`, `kills`, `deaths`, `headshotKills`, `players` (the same rules as the leaderboard's totals) and `suicides`                                                                 |
| `weapons`      | Up to 25 `{label, kind, kills, headshotKills, longestMeters}`, most kills first. Causes with one label are merged; "Unknown weapon" stays as an honest row                          |
| `maps`         | Up to 10 `{label, kills}`; a map's catalog ID and in-game name count once                                                                                                           |
| `longestKills` | Up to 10 `{name, weapon, meters, map}`: each player's own longest kill, so one sniper cannot fill the list                                                                          |
| `hours`        | 24 kill counts by UTC hour of receipt (index 0 is 00:00–00:59 UTC). The website shows them in the viewer's time zone                                                                |
| `tags`         | Counts for `melee`, `roadkill`, `vehicleExplosion`, `penetration`, `ricochet` (kills with that tag), `falling` (deaths with the Falling tag) and `suicide` (self-inflicted deaths)  |
| `tagLeaders`   | Up to 5 `{name, count}` for each tag except `suicide`, which is a count only: naming who self-inflicted most is in poor taste. Fall deaths are listed by victim, the rest by killer |

A kill is a non-suicide event with a linked killer, as on the leaderboard, so stats totals equal the leaderboard's totals for the same window. Distances over 2 km (`PUBLIC_MAX_DISTANCE_CENTIMETERS`, the weekly post's cap) are left out everywhere public; vehicle explosions and most suicides have no distance. Tags match the feed's full strings with or without the `Meta.Progression.Context.Player.KillContext.` and `Meta.PlayerKillFlag.Player.` prefixes.

**Names only.** Gramps serves `/community/api/*` on its own origin too, so its own output is safe without the website's proxy: no `steamId` key at any depth, no 17-digit run, and no killer or victim ids. Names, on the leaderboard rows and in the stats lists alike, use the latest non-empty name, then the public name rule, then the website's stricter rule (any 17-digit run in any script's digits becomes "Unnamed player"), trimmed to 64 characters. `publicServerStats()` builds every field one by one; nothing from storage is spread into the response. The website's adapter also rebuilds the response from an allowlist.

**Errors.** The server is resolved first (unknown server 404; no server with several configured 400), then the period (anything other than `day`, `week` or `month` is 400 "Choose day, week or month."), before any database read. With the feed off the response is the metadata and empty stats, with no database read. Database failures return the usual safe 503. The route shares the public read rate limit (300 a minute per proxy address) and the `no-store` headers.

**Cost.** Three statements in one read-only `repeatable read` transaction, each a range scan of `combat_events_received_idx` (`server_id`, `received_at`) with no materialized copy of the window:

1. Kills grouped by cause, map and UTC hour, plus the total, in one pass (`GROUPING SETS`).
2. Event totals: events, deaths, suicides, fall deaths and distinct players, grouped by player id first so Postgres hashes about 2k ids instead of sorting two rows per event.
3. Each killer's own longest capped kill (a hashed group over the same range), the ten best of those with their kill row read through the killer index, the top five per tag, and then names for only those players (at most 40): one latest-name probe each on the killer and victim indexes. Ranking players by their own best shot means a few snipers cannot fill the list; at an exact centimetre tie for tenth place the lower SteamID is kept.

The result is cached for 60 seconds per server and period (at most 30 entries, one shared read for concurrent callers, a failed read is not kept). Feed batches do not clear it, so recomputes stay at one per server and period per minute whatever the traffic. `asOf` and `feedStatus` describe the cached read.

**Check before relying on it (Dennis or staff, read-only):** run `EXPLAIN (ANALYZE, BUFFERS)` for the stats statements and for the row-extras streak query with a 30-day window on production-size data. The budget is under about 0.5 s warm for the three stats statements together and under 400 ms for the streak query. If the streak query is over budget for `month`, compute `bestStreak` only for `day` and `week`; the field is optional and the website already copes without it. Agents never run these against production.

**Release order.** Either order works. The website adapter treats a 404 from `/community/api/stats` as "coming soon" and the row extras are optional, so a new site with an older Gramps shows no stats and no extras, and an older site with a newer Gramps 404s `/stats` and strips the extras. Shipping the website first is preferred.

A weekly Discord post of the same names-only data, with data-backed shout-outs, is described in [Weekly Discord leaderboard post](WEEKLY_LEADERBOARD.md). It is off by default and stays silent without enough data.

The public website uses same-origin `/community/api` rewrites to Gramps. The game ingest endpoint should target Gramps directly, or a separately verified host forwarding service, with its feed-only authorization.

### Release order for names-only public rows

Public leaderboard rows no longer carry `steamId`. As of October 2, the production website's leaderboard page still drops every row without a valid `steamId`. If Gramps ships this change first, the public leaderboard is empty and reads like a quiet period, not an error. The website's names-only leaderboard (its Pages adapter `proxy/gramps.mjs` and `dist/leaderboard.js`) accepts rows with or without `steamId`.

- Do not merge this change to main or deploy it until the names-only website is published and live in production.
- Once both are live, do not roll the website back to a deployment older than its names-only release.
- If both must be reverted, roll Gramps back first, then the website.

## Retention and connection

Ingestion purges event rows older than 90 days, and event type counts for UTC days before that cutoff, at most once per day. If ingestion stops, deletion waits for the next accepted batch; this is not a guarantee of deletion at exactly 90 days during inactivity. Administrative cleanup is required for a permanently retired feed. Queries remain bounded to the selected rolling period. First/last receipt metadata remains for coverage reporting.

As of October 2, the UNCs host's saved feed base URL is `https://admin.theuncsgaming.com`, replacing the previous local xREALM receiver under Dennis's authorization. Preserving that receiver is no longer a requirement. The existing feed-only token is configured in Gramps and ingestion is enabled, but the dashboard still reports **Awaiting first combat batch**. Configuration is not proof of delivery. The observed game appends `/api/ingest/events` to the base URL and reads feed settings at startup; no game restart was issued.

At 09:35–09:41 EDT on October 2, read-only checks found:

- The saved `ServerSettings.ini` still contained the Gramps base URL, and xREALM's Killfeed page recognized an external feed destination. Neither establishes what the running game loaded or whether outbound delivery works.
- Railway's current deployment HTTP logs showed no requests matching `@path:/api/ingest/events`. This covers only that deployment, which started around 09:26, not the entire game uptime or earlier deployments.
- Public receipt metadata remained `waiting`, with no first or last received batch. The game then showed 0/100 players and all faction scores at zero. No natural combat event was available to verify delivery during this check.

For the next acceptance check, observe a genuine combat event during ordinary play and then inspect receipt metadata and the matching deployment's HTTP logs:

1. **No request:** investigate the destination actually loaded by the game and host outbound DNS/TLS/connectivity. A saved URL alone cannot identify which failed; do not guess a parser or token fix.
2. **Request rejected:** use its HTTP status and safe error category (staff `lastRejected` and the matching deployment log warning) to locate authentication, payload or storage failure. Do not publish request headers, tokens or raw player payloads.
3. **Request accepted:** verify that receipt metadata advances and the corresponding real event appears. Only then record native delivery as observed.

Do not manufacture kills, send test ingest requests or restart the live game to obtain this evidence.

The database schema is provided in `src/database/telemetry.schema.ts` and exported by the main schema. The combined launch migration was applied to the identified production database on September 30 under the owner's explicit authorization, and schema checks passed; see [Database prerequisite](ADMIN_DASHBOARD.md#database-prerequisite--launch-migration-applied). Production uses Node 22.23.3. Consult the [current release audit](ADMIN_RELEASE_AUDIT.md) for dated configuration and delivery evidence. Never probe production ingest with invented kills or print feed credentials.

The local preview overrides the store with explicit simulated events and cannot accept a live game feed. No real player history is imported into the preview. Its simulated events use the game's cause spellings, kill-context tags and centimetre distances, and include one fictional player with a very long name, so the public stats, row extras and phone layouts can be checked by eye.

## Later moderation assistance

Once actual events and coverage have been verified, possible staff-review prompts include sustained unusual infantry kill bursts, high observed headshot shares across a meaningful sample, unusual weapon/distance combinations, and repeated same-victim patterns. Each prompt must show the supporting events, omit vehicle/environment/suicide cases where appropriate, and allow staff to dismiss it. These prompts are not implemented in this version; they must not be presented as proven cheating.
