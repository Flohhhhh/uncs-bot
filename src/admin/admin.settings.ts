import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { EnvService } from "../env/env.service";
import {
  LEGACY_SERVER_ID,
  LEGACY_SERVER_NAME,
  validRconUrl,
  type GameServerSummary,
  type RconConnection,
} from "../common/game-server";
import type { StaffPolicy } from "../common/admin-policy";

@Injectable()
export class AdminSettings {
  constructor(private readonly env: EnvService) {}

  get() {
    if (!this.env.get("ADMIN_ENABLED"))
      throw new ServiceUnavailableException("The staff dashboard has not been connected yet.");
    const identity = this.identity(this.env.get("ADMIN_ORIGIN"));
    return { ...identity, ...this.staffPolicy() };
  }

  /** Staff owner and role IDs. Unlike get(), readable while the dashboard is off, for Discord staff commands. */
  staffPolicy() {
    const ids = (value: string) =>
      value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    return {
      ownerIds: ids(this.env.get("ADMIN_OWNER_IDS")),
      adminRoleIds: ids(this.env.get("ADMIN_ADMIN_ROLE_IDS")),
      moderatorRoleIds: ids(this.env.get("ADMIN_MODERATOR_ROLE_IDS")),
      viewerRoleIds: ids(this.env.get("ADMIN_VIEWER_ROLE_IDS")),
    } satisfies StaffPolicy;
  }

  applicant() {
    if (!this.env.get("WHITELIST_APPLICATIONS_ENABLED"))
      throw new ServiceUnavailableException("Website applications are not open yet. Please check back here.");
    return this.identity(this.env.get("APPLICATION_ORIGIN"));
  }

  /**
   * The Discord sign-in for "Link Patreon" on the dashboard's own origin. Unlike get() and applicant(), it needs
   * neither the dashboard nor website applications switched on.
   */
  patronLink() {
    return this.identity(this.env.get("ADMIN_ORIGIN"));
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

  /** Public identity and connection version only; never expose an endpoint or password. */
  servers(): GameServerSummary[] {
    const configured = this.env.get("WARDOGS_SERVERS");
    const definitions: Array<{ id: string; name: string; rconUrl: string; joinId?: string }> = configured ?? [
      {
        id: LEGACY_SERVER_ID,
        name: LEGACY_SERVER_NAME,
        rconUrl: this.env.get("WARDOGS_RCON_URL") ?? "",
        joinId: this.env.get("WARDOGS_SERVER_JOIN_ID"),
      },
    ];
    return definitions.map(({ id, name, rconUrl, joinId }) => ({
      id,
      name,
      ...(joinId ? { joinId } : {}),
      version: createHash("sha256")
        .update(`${id}\n${rconUrl.replace(/\/+$/, "")}`)
        .digest("hex"),
    }));
  }

  explicitServers() {
    return this.env.get("WARDOGS_SERVERS") !== undefined;
  }
  feedToken(id: string) {
    const configured = this.env.get("WARDOGS_SERVERS");
    if (configured) return configured.find((server) => server.id === id)?.feedToken;
    if (id !== LEGACY_SERVER_ID) return undefined;
    const token = this.env.get("WARDOGS_FEED_TOKEN");
    return token !== this.env.get("WARDOGS_RCON_PASSWORD") ? token : undefined;
  }

  serverRoles(id: string) {
    return this.env.get("WARDOGS_SERVERS")?.find((server) => server.id === id)?.staffRoles;
  }

  connection(serverId: string): RconConnection {
    const configured = this.env.get("WARDOGS_SERVERS");
    if (configured) {
      const server = configured.find(({ id }) => id === serverId);
      if (!server) throw new ServiceUnavailableException("That game server is not configured.");
      return { rconUrl: server.rconUrl, password: server.password };
    }
    if (serverId !== LEGACY_SERVER_ID) throw new ServiceUnavailableException("That game server is not configured.");
    const rconUrl = this.env.get("WARDOGS_RCON_URL");
    const password = this.env.get("WARDOGS_RCON_PASSWORD");
    if (!rconUrl || !password) throw new ServiceUnavailableException("The game server has not been connected yet.");
    if (!validRconUrl(rconUrl)) throw new ServiceUnavailableException("The game connection settings need attention.");
    return { rconUrl, password };
  }

  /** Legacy callers must never choose an arbitrary target once the registry is in use. */
  rcon(): RconConnection {
    if (this.env.get("WARDOGS_SERVERS"))
      throw new ServiceUnavailableException("An explicit server selection is required for this operation.");
    return this.connection(LEGACY_SERVER_ID);
  }

  private url(value: string) {
    try {
      return new URL(value);
    } catch {
      throw new ServiceUnavailableException("The connection settings need attention.");
    }
  }
}
