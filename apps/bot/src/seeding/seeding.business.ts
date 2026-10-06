import { Injectable } from "@nestjs/common";
import { acknowledged, seedingContext, type InteractionContext } from "@uncs/contracts";
import type { z } from "zod";
import { RemoteService } from "../internal/transport";
@Injectable()
export class SeedingBusiness {
  private context?: z.infer<typeof seedingContext>;
  constructor(private readonly remote: RemoteService) {}
  async load() {
    this.context = await this.remote.request("/internal/v1/seeding/context", seedingContext);
    return this.context;
  }
  staffPolicy() {
    if (!this.context) throw new Error("Seeding configuration is unavailable.");
    return this.context.policy;
  }
  server() {
    return this.context?.server;
  }
  authorize(context: InteractionContext) {
    return this.remote.request("/internal/v1/seeding/authorize", acknowledged, context);
  }
}
