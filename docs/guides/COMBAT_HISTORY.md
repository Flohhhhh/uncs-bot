# Combat history and server leaderboard

The optional Wardogs feed stores combat events for this server and exposes rolling 24-hour, 7-day and 30-day views. The public website leaderboard contains game display names, recorded kills/deaths, headshot kills and K/D, never SteamID64s; a SteamID shown in place of a missing name becomes "Unnamed player". Authenticated staff rankings keep SteamID64s for moderation and player history. Authenticated staff can inspect the recent killfeed and a selected player's events. Application emails, Discord account details and application review notes are never joined into this data.

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
- `GET /admin/api/combat?period=...`: authenticated staff history, including the event type counts above.
- `GET /admin/api/combat/players/:steamId?period=...`: authenticated staff player history.

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

The local preview overrides the store with explicit simulated events and cannot accept a live game feed. No real player history is imported into the preview.

## Later moderation assistance

Once actual events and coverage have been verified, possible staff-review prompts include sustained unusual infantry kill bursts, high observed headshot shares across a meaningful sample, unusual weapon/distance combinations, and repeated same-victim patterns. Each prompt must show the supporting events, omit vehicle/environment/suicide cases where appropriate, and allow staff to dismiss it. These prompts are not implemented in this version; they must not be presented as proven cheating.
