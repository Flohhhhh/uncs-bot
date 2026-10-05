# Rotating passwords and tokens

Step-by-step owner runbook for changing each secret Gramps uses. Rotate a secret when it may have been seen by someone or something that should not have it: a third-party bot with RCON or config access, a pasted screenshot, a departed staff member with host access, or a leaked log. When the project changes hands, rotate every secret below, because the previous owner could see them all. Otherwise there is no schedule.

## Before you start

- Pick a quiet moment. Every rotation below has a short gap where the old secret has stopped working and the new one is not live yet. Check the dashboard overview for **0 players** first.
- Generate each new secret on your own machine. This gives 43 URL-safe characters, enough for every secret below:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  ```

- Never paste a secret into Discord, a ticket, a PR, a screenshot or a chat with anyone, including Claude. Paste it only into the host panel or the Railway variable.
- Use a different value for every secret. The feed token must never equal the RCON password.
- In Railway, editing a variable stages the change. Choose **Deploy** to apply it; the bot restarts with the new value. The previous deployment stays in the history if you need to roll back code, but a rolled-back deployment uses the current variables.
- To rotate several secrets at once, change each one at its provider, stage every Railway edit, then deploy once. All the gaps below then overlap in one short outage.
- Where this guide says `WARDOGS_RCON_PASSWORD` or `WARDOGS_FEED_TOKEN`, a deployment that uses `WARDOGS_SERVERS` keeps those values in each server's `password` and `feedToken` instead. Edit that JSON carefully and keep every other field as it is.

## RCON password

Used by the dashboard and the bot for every game read and action: the overview, the whitelist, announcements, in-game messages, kicks and bans requested by staff.

1. On the host (xREALM), set the new RCON password in the server configuration and apply it as the panel requires.
2. In Railway, set `WARDOGS_RCON_PASSWORD` (or that server's `password` in `WARDOGS_SERVERS`) to the same value and deploy.
3. Check: the dashboard overview shows **Server responding** and the whitelist page lists entries under **Running game**.

Between steps 1 and 2 the dashboard cannot read or change the game, and in-game welcome and round messages can be missed.

## Game feed token (`[WDServerFeed]`)

The game sends kill events to Gramps with this token. It is separate from the RCON password.

1. On the host, set the new token in the `[WDServerFeed]` section of the server configuration. Leave the feed URL unchanged.
2. In Railway, set `WARDOGS_FEED_TOKEN` (or that server's `feedToken` in `WARDOGS_SERVERS`) to the same value and deploy.
3. Check after the next kill: **Combat history** shows a recent batch and no new `token mismatch` refusals.

Kills sent between steps 1 and 2 are refused and may be lost for good, so do this with the server empty.

## Discord bot token

1. In the [Discord Developer Portal](https://discord.com/developers/applications), open the Gramps application, then **Bot** → **Reset Token**. The old token stops working immediately and the bot goes offline.
2. In Railway, set `DISCORD_BOT_TOKEN` and deploy.
3. Check: the deploy log shows `Logged in as Gramps`, and the bot is online in the member list.

## Dashboard sign-in (Discord OAuth client secret)

1. In the Developer Portal, open **OAuth2** → **Reset Secret**. Staff and applicant sign-in fails until step 2 is live; existing sessions keep working. While Link Patreon is on, patrons who are partway through end at "Link expired" too.
2. In Railway, set `ADMIN_DISCORD_CLIENT_SECRET` and deploy.
3. Check: sign in to the dashboard in a private window. While Link Patreon is on, `/patreon panel` in a test channel should post the panel or name the setting to fix.

## Dashboard session secret

`ADMIN_SESSION_SECRET` signs two things: the short-lived sign-in state, and applicant sessions on the website. Applicant sessions are signed cookies that last 30 minutes, so anyone holding the secret could create one for any Discord account and use the application pages as that person. Treat it like a password.

Changing it and deploying cancels sign-ins that are halfway through and signs every applicant out. Staff dashboard sessions are stored in the database and keep working. To sign every staff member out, a database operator must delete the dashboard session records; see [Admin security](ADMIN_SECURITY.md#deployment-and-incident-checks). To lock the dashboard during an incident, set `ADMIN_ENABLED=false` and deploy.

## Database password

`DATABASE_URL` contains the password of the database role Gramps signs in with. Production runs on Neon.

1. In the Neon console, reset the password of that role on the production branch. Neon resets are branch-scoped, so also reset it on every other branch that holds a copy of production data, or delete those branches. Then restart the compute, so connections made with the old password close.
2. In Railway, set `DATABASE_URL` to the new connection string and deploy. The pre-deploy migration uses the same value.
3. Check: the deploy finishes (startup stops if the database check fails) and the dashboard overview loads.

Between steps 1 and 2 Gramps cannot reach the database, so do this with the server empty.

## Patreon

- **Creator's Access Token:** renew it on the [Patreon client page](https://www.patreon.com/portal/registration/register-clients), set `PATREON_CREATOR_ACCESS_TOKEN` in Railway and deploy. On the Supporters page, the sync status should show a fresh successful sync and no rejected token.
- **Webhook secret** (only if the optional webhook is set up): change it in the Patreon webhook settings and set `PATREON_WEBHOOK_SECRET` in Railway at the same time. Deliveries in between are refused; the scheduled import still brings in the same members and payments on its next run.
- **Client secret** (only if [Link Patreon](PATREON_SUPPORTERS.md#link-patreon-patrons-link-their-own-discord) is set up):
  1. On the [Patreon client page](https://www.patreon.com/portal/registration/register-clients), open the client behind the creator token and get a new client secret. If Patreon offers no way to change it, create a new client instead and redo the [Link Patreon setup](PATREON_SUPPORTERS.md#owner-setup). A new client also brings a new Client ID and Creator's Access Token, and needs the redirect URI added again. Patrons partway through cannot finish until step 2 is live.
  2. In Railway, set `PATREON_CLIENT_SECRET` (and `PATREON_CLIENT_ID` and `PATREON_CREATOR_ACCESS_TOKEN` if they changed) and deploy. The new secret must differ from every other secret.
  3. Check: `/patreon panel` in a test channel posts the panel or names the setting to fix, and the Supporters page shows a fresh successful sync, because changing the client can replace the creator token.

See [Patreon supporters](PATREON_SUPPORTERS.md) for what the sync status means.

## After any rotation

- Delete the value from wherever you generated or kept it, apart from your password manager.
- If the rotation followed a leak, also check the whitelist, the ban list and the dashboard's staff activity for changes nobody on staff made.
