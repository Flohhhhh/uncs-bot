import { ConditionalModule, ConfigModule } from "@nestjs/config";
import {
  PatronLinkCommandsModule,
  patronLinkCommandsEnabled,
} from "../../../src/patron-link/patron-link-commands.module";

describe("the /patreon command's module", () => {
  it.each([
    ["true", true],
    ["false", false],
    [undefined, false],
    ["", false],
    ["TRUE", false],
    ["1", false],
    ["yes", false],
  ])("registers for PATREON_LINK_ENABLED=%p: %p", (value, registered) => {
    expect(patronLinkCommandsEnabled(value === undefined ? {} : { PATREON_LINK_ENABLED: value })).toBe(registered);
  });

  it("is what ConditionalModule imports only while the switch is exactly true", async () => {
    const before = process.env.PATREON_LINK_ENABLED;
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await ConfigModule.forRoot({ ignoreEnvFile: true });
      await ConfigModule.envVariablesLoaded;
      delete process.env.PATREON_LINK_ENABLED;
      const unset = await ConditionalModule.registerWhen(PatronLinkCommandsModule, patronLinkCommandsEnabled, {
        debug: false,
      });
      expect(unset.imports).toEqual([]);
      process.env.PATREON_LINK_ENABLED = "true";
      const on = await ConditionalModule.registerWhen(PatronLinkCommandsModule, patronLinkCommandsEnabled, {
        debug: false,
      });
      expect(on.imports).toEqual([PatronLinkCommandsModule]);
    } finally {
      if (before === undefined) delete process.env.PATREON_LINK_ENABLED;
      else process.env.PATREON_LINK_ENABLED = before;
      jest.restoreAllMocks();
    }
  });
});
