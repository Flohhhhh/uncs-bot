# REST API Integration

> 💡 **Initial Version** \
> This section will eventually be rewritten and the overall REST API integration may change in the future. I initially spent a short amount of time focusing on REST API integration and wanted to get support for it out quickly. Expect this section to be improved over time, after the core of the template is built.

> This template makes use of NestJS under the hood, which is actually primarily a web framework for building REST APIs! This template won't teach you how to build a NestJS application, since the focus is on building a Discord bot, not a web server. However, you'll find that [NestJS' docs](https://docs.nestjs.com/) are very well written and include a lot of examples to help solve common problems, such as authentication, validation, database integration, etc.

This template is already setup to accept incoming HTTP requests! You can test this right now by starting your bot locally and going to `http://localhost:3000/health` in your web browser. You should see a JSON response like this:

```json
{
  "status": "ok"
}
```

Until the bot has signed in to Discord, the same endpoint answers `503` with `{ "status": "starting" }`. See [Startup order and the health check](#2-startup-order-and-the-health-check).

However, if you're using the Railway template, you'll need to make a small change to your Railway project settings to allow incoming HTTP requests. Follow the steps below to enable the REST API functionality.

## 1. Railway Configuration

After you've deployed your bot with Railway as suggested in the main README, you need to make a small change to your Railway project settings to allow incoming HTTP requests.

1. Go to your Railway project dashboard.
2. In the "Architecture" tab, click on your bot's service, then click on the "Settings" tab.
3. Under the "Networking" section, choose either "Generate Domain" to get a free Railway subdomain, or "Custom Domain" if you have your own domain name.
4. When prompted for the port, you may choose whatever port you want. If you're not sure, just use `3000`, which is a common default port for NestJS applications.
5. Save your changes. Once the changes are saved, Railway will automatically redeploy your bot with the new settings. You can visit the `/health` endpoint at your new domain to verify that it's working.

## 2. Startup order and the health check

The HTTP port opens before the bot signs in to Discord: after the database check and route setup, but without waiting for Discord's gateway. The dashboard, the game kill-feed ingest (`/api/ingest/...`), the public community API and the Patreon webhooks therefore answer while the sign-in is still pending, for example while Discord's gateway is slow or is holding the sign-in back with a rate limit.

Everything that needs Discord still waits for it:

- `/health` answers `503 {"status":"starting"}` until Discord is signed in and the background workers have started, then `200 {"status":"ok"}` for the rest of the process's life. That is the moment the bot used to start answering HTTP at all.
- The background workers (community messages, staff alerts, map votes, events, the weekly board and the Patreon sync) start only after the sign-in, in the same order as before. Until then, starting an optional event answers that Gramps is still starting, so no event waits for a worker that is not running yet.
- Slash commands and buttons arrive through Discord's gateway, so none run before the sign-in. Dashboard actions that post to Discord or check a Discord channel, such as starting a ballot or posting the weekly board, answer that Discord is not ready.
- Staff dashboard and applicant sign-in check roles and membership through Discord's API with the bot token, not through the gateway, and deny access whenever Discord cannot confirm them.

If the sign-in fails outright, the bot logs `Failed to bootstrap the application` and exits with code 1 so Railway restarts it, as before. That covers a rejected token or a missing privileged intent, and also most Discord outages: discord.js gives up when Discord's gateway lookup keeps failing or the first gateway connection errors. HTTP is then unavailable from the exit until a restarted process opens the port again, so an outage like that still interrupts the routes above.

On Railway, set the service's **Healthcheck Path** (Settings → Deploy) to `/health`. Railway then switches traffic to a new deployment only once its Discord sign-in has completed, and keeps the running deployment if the new one does not sign in within the healthcheck timeout. This repository has no `railway.json`, so the setting lives in the Railway dashboard.
