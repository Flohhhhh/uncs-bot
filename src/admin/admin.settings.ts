import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { EnvService } from "../env/env.service";

@Injectable()
export class AdminSettings {
  constructor(private readonly env: EnvService) {}

  get() {
    const origin = this.env.get("ADMIN_ORIGIN");
    const clientId = this.env.get("ADMIN_DISCORD_CLIENT_ID");
    const clientSecret = this.env.get("ADMIN_DISCORD_CLIENT_SECRET");
    const secret = this.env.get("ADMIN_SESSION_SECRET");
    const guildId = this.env.get("ADMIN_GUILD_ID");
    const rconUrl = this.env.get("WARDOGS_RCON_URL");
    const password = this.env.get("WARDOGS_RCON_PASSWORD");
    if (
      !this.env.get("ADMIN_ENABLED") ||
      !origin ||
      !clientId ||
      !clientSecret ||
      !secret ||
      !guildId ||
      !rconUrl ||
      !password
    ) {
      throw new ServiceUnavailableException("The staff dashboard has not been connected yet.");
    }
    const site = new URL(origin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname);
    const endpoint = new URL(rconUrl);
    if (
      (site.protocol !== "https:" &&
        !(site.protocol === "http:" && local && this.env.get("NEST_ENV") === "development")) ||
      site.origin !== origin ||
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new ServiceUnavailableException("The staff dashboard connection settings need attention.");
    }
    const ids = (value: string) =>
      value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    return {
      origin,
      clientId,
      clientSecret,
      secret,
      guildId,
      rconUrl,
      password,
      secure: site.protocol === "https:",
      botToken: this.env.get("DISCORD_BOT_TOKEN"),
      ownerIds: ids(this.env.get("ADMIN_OWNER_IDS")),
      adminRoleIds: ids(this.env.get("ADMIN_ADMIN_ROLE_IDS")),
      moderatorRoleIds: ids(this.env.get("ADMIN_MODERATOR_ROLE_IDS")),
      viewerRoleIds: ids(this.env.get("ADMIN_VIEWER_ROLE_IDS")),
    };
  }
}
