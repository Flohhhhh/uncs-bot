# Rotating passwords and tokens

Step-by-step owner runbook for changing each secret Gramps uses. Rotate a secret when it may have been seen by someone or something that should not have it: a third-party bot with RCON or config access, a pasted screenshot, a departed staff member with host access, or a leaked log. Otherwise there is no schedule.

## Before you start

- Pick a quiet moment. Every rotation below has a short gap where the old secret has stopped working and the new one is not live yet. Check the dashboard overview for **0 players** first.
- Generate each new secret on your own machine. This gives 43 URL-safe characters, enough for every secret below:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  ```

- Never paste a secret into Discord, a ticket, a PR, a screenshot or a chat with anyone, including Claude. Paste it only into the host panel or the Railway variable.
- Use a different value for every secret. The feed token must never equal the RCON password.
- In Railway, editing a variable stages the change. Choose **Deploy** to apply it; the bot restarts with the new value. The previous deployment stays in the history if you need to roll back code, but a rolled-back deployment uses the current variables.
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

1. In the Developer Portal, open **OAuth2** → **Reset Secret**. Staff and applicant sign-in fails until step 2 is live; existing sessions keep working.
2. In Railway, set `ADMIN_DISCORD_CLIENT_SECRET` and deploy.
3. Check: sign in to the dashboard in a private window.

## Dashboard session secret

`ADMIN_SESSION_SECRET` protects the short-lived sign-in state, not the sessions themselves. Changing it and deploying only cancels sign-ins that are halfway through. To sign everyone out, a database operator must delete the dashboard session records; see [Admin security](ADMIN_SECURITY.md#deployment-and-incident-checks). To lock the dashboard during an incident, set `ADMIN_ENABLED=false` and deploy.

## Patreon

- **Creator's Access Token:** renew it on the [Patreon client page](https://www.patreon.com/portal/registration/register-clients), set `PATREON_CREATOR_ACCESS_TOKEN` in Railway and deploy. On the Supporters page, the sync status should show a fresh successful sync and no rejected token.
- **Webhook secret** (only if the optional webhook is set up): change it in the Patreon webhook settings and set `PATREON_WEBHOOK_SECRET` in Railway at the same time. Deliveries in between are refused; the scheduled import still brings in the same members and payments on its next run.

See [Patreon supporters](PATREON_SUPPORTERS.md) for what the sync status means.

## After any rotation

- Delete the value from wherever you generated or kept it, apart from your password manager.
- If the rotation followed a leak, also check the whitelist, the ban list and the dashboard's staff activity for changes nobody on staff made.
