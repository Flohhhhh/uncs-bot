import { Injectable, NotFoundException } from "@nestjs/common";
import { AdminSettings } from "./admin.settings";
import { WardogsClient } from "./wardogs.client";
import type { GameServerSummary } from "../common/game-server";

/** One immutable connection and one read/backoff cache per configured server. */
@Injectable()
export class GameServers {
  private readonly clients = new Map<string, WardogsClient>();

  constructor(private readonly settings: AdminSettings) {}

  list(): GameServerSummary[] {
    return this.settings.servers();
  }

  get(id: string): WardogsClient {
    if (!this.list().some((server) => server.id === id))
      throw new NotFoundException("Choose a configured game server.");
    let client = this.clients.get(id);
    if (!client) {
      const connection = this.settings.connection(id);
      client = new WardogsClient({ rcon: () => connection });
      this.clients.set(id, client);
    }
    return client;
  }
}
