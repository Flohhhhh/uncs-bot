import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AdminAuth } from "../admin/admin.auth";
import { AdminSettings } from "../admin/admin.settings";
import { AdminStore } from "../admin/admin.store";
import { GameServers } from "../admin/game-servers";
import type { WardogsClient } from "../admin/wardogs.client";
import type { Staff } from "../admin/admin.types";
import { createPreviewGame } from "./preview-game";

/** Only this development composition substitutes game transport; auth and storage remain real. */
@Injectable()
export class BackendGameServers extends GameServers {
  private readonly samples = new Map<string, WardogsClient>();
  constructor(
    settings: AdminSettings,
    private readonly config: ConfigService,
  ) {
    super(settings);
  }
  override get(id: string): WardogsClient {
    if (this.config.get("BACKEND_GAME_MODE") !== "sample") return super.get(id);
    const resolved = this.resolve(id);
    let client = this.samples.get(resolved);
    if (!client) {
      const scenario = this.config.get<string>("BACKEND_SAMPLE_SCENARIO");
      client = createPreviewGame(this.list().find((server) => server.id === resolved)!.name, resolved === "event", {
        mode: scenario === "standard" ? "live" : scenario,
        readOnly: true,
      }).game;
      this.samples.set(resolved, client);
    }
    return client;
  }
}

/** Add data-source metadata only after the existing real session/permission check succeeds. */
@Injectable()
export class BackendAuth extends AdminAuth {
  constructor(
    settings: AdminSettings,
    store: AdminStore,
    private readonly config: ConfigService,
  ) {
    super(settings, store);
  }
  override async authenticate(
    req: Parameters<AdminAuth["authenticate"]>[0],
  ): Promise<Staff & { gameMode: "live" | "sample" }> {
    const staff = await super.authenticate(req);
    return { ...staff, gameMode: this.config.get("BACKEND_GAME_MODE") === "sample" ? "sample" : "live" };
  }
}
