import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { EnvService } from "../env/env.service";

@Injectable()
export class AdminSettings {
  constructor(private readonly env: EnvService) {}

  get() {
    if (!this.env.get("ADMIN_ENABLED"))
      throw new ServiceUnavailableException("The staff dashboard has not been connected yet.");
    const identity = this.identity(this.env.get("ADMIN_ORIGIN"));
    const ids = (value: string) =>
      value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    return {
      ...identity,
      ownerIds: ids(this.env.get("ADMIN_OWNER_IDS")),
      adminRoleIds: ids(this.env.get("ADMIN_ADMIN_ROLE_IDS")),
      moderatorRoleIds: ids(this.env.get("ADMIN_MODERATOR_ROLE_IDS")),
      viewerRoleIds: ids(this.env.get("ADMIN_VIEWER_ROLE_IDS")),
    };
  }

  applicant() {
    if (!this.env.get("WHITELIST_APPLICATIONS_ENABLED"))
      throw new ServiceUnavailableException("Website applications are not open yet. Please check back here.");
    return this.identity(this.env.get("APPLICATION_ORIGIN"));
  }

  private identity(origin: string | undefined) {
    const clientId = this.env.get("ADMIN_DISCORD_CLIENT_ID");
    const clientSecret = this.env.get("ADMIN_DISCORD_CLIENT_SECRET");
    const secret = this.env.get("ADMIN_SESSION_SECRET");
    const guildId = this.env.get("ADMIN_GUILD_ID");
    if (!origin || !clientId || !clientSecret || !secret || !guildId) {
      throw new ServiceUnavailableException("Discord sign-in has not been connected yet.");
    }
    const site = this.url(origin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname);
    if (
      (site.protocol !== "https:" &&
        !(site.protocol === "http:" && local && this.env.get("NEST_ENV") === "development")) ||
      site.origin !== origin
    ) {
      throw new ServiceUnavailableException("The sign-in connection settings need attention.");
    }
    return {
      origin,
      clientId,
      clientSecret,
      secret,
      guildId,
      secure: site.protocol === "https:",
      botToken: this.env.get("DISCORD_BOT_TOKEN"),
    };
  }

  rcon() {
    const rconUrl = this.env.get("WARDOGS_RCON_URL");
    const password = this.env.get("WARDOGS_RCON_PASSWORD");
    if (!rconUrl || !password) throw new ServiceUnavailableException("The game server has not been connected yet.");
    const endpoint = this.url(rconUrl);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new ServiceUnavailableException("The game connection settings need attention.");
    return { rconUrl, password };
  }

  private url(value: string) {
    try {
      return new URL(value);
    } catch {
      throw new ServiceUnavailableException("The connection settings need attention.");
    }
  }
}
