# Combat history and server leaderboard

The optional Wardogs feed stores combat events for this server and exposes rolling 24-hour, 7-day and 30-day views. The public website leaderboard contains game display names, SteamID64, recorded kills/deaths and K/D. Authenticated staff can inspect the recent killfeed and a selected player's events. Application emails, Discord account details and application review notes are never joined into this data.

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

`WARDOGS_FEED_ENABLED=false` by default. `WARDOGS_FEED_TOKEN` is a separate random feed-only secret, at least 32 characters, and must differ from the RCON password. It is never sent to player browsers.

The game POSTs batches to `POST /api/ingest/events` using `Authorization: Bearer <feed token>`. The configured token determines the authorized server; the incoming `serverId` is only a per-boot instance identifier. Payload size, batch length, numbers and strings are bounded. Unknown event types are skipped; malformed killed events are rejected. Unexpected errors do not return raw payloads, database strings or credentials.

Events are stored transactionally with a unique instance/event ID pair so repeat deliveries cannot inflate retained statistics. Aggregation occurs in PostgreSQL. The public leaderboard returns the top 100, while aggregate totals cover all recorded players. Staff event views return the latest 100 events in the selected window; older events within retention remain included in aggregates.

Routes:

- `GET /community/api/leaderboard?period=day|week|month`: public game statistics only.
- `GET /admin/api/combat?period=...`: authenticated staff history.
- `GET /admin/api/combat/players/:steamId?period=...`: authenticated staff player history.

The public website uses same-origin `/community/api` rewrites to Gramps. The game ingest endpoint should target Gramps directly, or a separately verified host forwarding service, with its feed-only authorization.

## Retention and connection

Ingestion purges event rows older than 90 days at most once per day. If ingestion stops, deletion waits for the next accepted batch; this is not a guarantee of deletion at exactly 90 days during inactivity. Administrative cleanup is required for a permanently retired feed. Queries remain bounded to the selected rolling period. First/last receipt metadata remains for coverage reporting.

As of October 2, the UNCs host's saved feed base URL is `https://admin.theuncsgaming.com`, replacing the previous local xREALM receiver under Dennis's authorization. Preserving that receiver is no longer a requirement. The existing feed-only token is configured in Gramps and ingestion is enabled, but the dashboard still reports **Awaiting first combat batch**. Configuration is not proof of delivery. The observed game appends `/api/ingest/events` to the base URL and reads feed settings at startup; no game restart was issued. Check receipt metadata after a normal start before claiming the integration works.

The database schema is provided in `src/database/telemetry.schema.ts` and exported by the main schema. The combined launch migration was applied to the identified production database on September 30 under the owner's explicit authorization, and schema checks passed; see [Database prerequisite](ADMIN_DASHBOARD.md#database-prerequisite--launch-migration-applied). Production uses Node 22.23.3. Consult the [current release audit](ADMIN_RELEASE_AUDIT.md) for dated configuration and delivery evidence. Never probe production ingest with invented kills or print feed credentials.

The local preview overrides the store with explicit simulated events and cannot accept a live game feed. No real player history is imported into the preview.

## Later moderation assistance

Once actual events and coverage have been verified, possible staff-review prompts include sustained unusual infantry kill bursts, high observed headshot shares across a meaningful sample, unusual weapon/distance combinations, and repeated same-victim patterns. Each prompt must show the supporting events, omit vehicle/environment/suicide cases where appropriate, and allow staff to dismiss it. These prompts are not implemented in this version; they must not be presented as proven cheating.
