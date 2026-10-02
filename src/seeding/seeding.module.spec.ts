import { Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Client } from "discord.js";
import { SeedingCommand } from "../commands/handlers/seeding.command";
import { ComponentsModule } from "../components/components.module";
import { SeedingComponent } from "../components/handlers/seeding.component";
import { DATABASE } from "../database/database.types";
import { EnvService } from "../env/env.service";
import { SeedingModule } from "./seeding.module";
import { SeedingService } from "./seeding.service";

@Global()
@Module({
  providers: [
    { provide: EnvService, useValue: { get: () => undefined } },
    { provide: Client, useValue: {} },
    { provide: DATABASE, useValue: {} },
  ],
  exports: [EnvService, Client, DATABASE],
})
class TestDependenciesModule {}

/** CommandsModule's seeding wiring. The real module can't load under Jest, which has no `src/` import alias. */
@Module({ imports: [SeedingModule], providers: [SeedingCommand] })
class TestCommandsModule {}

describe("seeding wiring", () => {
  it("gives the /seeding command and the panel buttons one shared service, so they share one cooldown", async () => {
    const app = await Test.createTestingModule({
      imports: [TestDependenciesModule, TestCommandsModule, ComponentsModule],
    }).compile();
    const service = app.get(SeedingService, { strict: false });
    expect(service).toBeInstanceOf(SeedingService);
    expect(Reflect.get(app.get(SeedingCommand, { strict: false }), "seeding")).toBe(service);
    expect(Reflect.get(app.get(SeedingComponent, { strict: false }), "seeding")).toBe(service);
    await app.close();
  });
});
