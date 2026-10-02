import { ApplicationCommandOptionType } from "discord.js";
import { OPTIONS_METADATA } from "necord";
import { PurgeCommand } from "./purge.command";

describe("/purge", () => {
  it("asks Discord for a whole number of messages, since a fractional amount cannot be deleted", () => {
    const options = Reflect.getMetadata(OPTIONS_METADATA, PurgeCommand.prototype.handlePurge);
    expect(options.amount).toMatchObject({
      name: "amount",
      type: ApplicationCommandOptionType.Integer,
      resolver: "getInteger",
      required: true,
      min_value: 1,
      max_value: 100,
    });
  });
});
