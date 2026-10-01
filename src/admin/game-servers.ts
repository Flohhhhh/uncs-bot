import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { AdminSettings } from "./admin.settings";
import { WardogsClient } from "./wardogs.client";
import { LEGACY_SERVER_ID, type GameServerSummary } from "../common/game-server";
import { createHash } from "node:crypto";

/** One immutable connection and one read/backoff cache per configured server. */
@Injectable()
export class GameServers {
  private readonly clients = new Map<string, { client: WardogsClient; version: string }>();

  constructor(private readonly settings: AdminSettings) {}

  list(): GameServerSummary[] {
    return this.settings.servers();
  }
  feedToken(id: string) {
    return this.settings.feedToken(this.resolve(id));
  }
  resolve(id?: string): string {
    if (!id && this.settings.explicitServers())
      throw new BadRequestException("Select a game server before continuing.");
    const selected = id ?? LEGACY_SERVER_ID;
    if (!this.list().some((server) => server.id === selected))
      throw new NotFoundException("Choose a configured game server.");
    return selected;
  }
  checkVersion(id: string, version?: string) {
    if (
      (this.settings.explicitServers() || version !== undefined) &&
      this.list().find((server) => server.id === id)?.version !== version
    )
      throw new ConflictException("The selected server connection changed. Refresh and review the action again.");
  }
  connectionHash(id: string) {
    const endpoint = this.settings.connection(this.resolve(id)).rconUrl;
    return createHash("sha256").update(new URL(endpoint).toString().replace(/\/$/, "")).digest("hex");
  }

  get(id: string): WardogsClient {
    const definition = this.list().find((server) => server.id === id);
    if (!definition) throw new NotFoundException("Choose a configured game server.");
    let entry = this.clients.get(id);
    if (entry && entry.version !== definition.version)
      throw new ConflictException("The server configuration changed. Restart this instance before connecting.");
    if (!entry) {
      const connection = this.settings.connection(id);
      entry = { client: new WardogsClient({ rcon: () => connection }), version: definition.version };
      this.clients.set(id, entry);
    }
    return entry.client;
  }
}
