import { MessageFlags } from "discord.js";
import type { ButtonContext } from "necord";
import type { EnvService } from "../../env/env.service";
import { PATRON_COPY } from "../../patron-link/patron-link.copy";
import { PatronLinkService } from "../../patron-link/patron-link.service";
import { PatronLinkComponent } from "./patron-link.component";

const REQUEST = {
  guildId: "200000000000000001",
  channelId: "400000000000000002",
  userId: "500000000000000001",
  bot: false,
  roles: [],
};

function interaction() {
  return {
    guildId: REQUEST.guildId,
    channelId: REQUEST.channelId,
    user: { id: REQUEST.userId, bot: false },
    member: { roles: [] },
    deferReply: jest.fn(),
    editReply: jest.fn(),
    update: jest.fn(),
  };
}

it("does what /patreon link does, privately, and leaves the panel untouched", async () => {
  const service = { request: jest.fn().mockResolvedValue({ content: "link", components: ["row"] }) };
  const component = new PatronLinkComponent(service as unknown as PatronLinkService);
  const button = interaction();
  await component.link([button] as unknown as ButtonContext);
  expect(button.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  expect(button.deferReply.mock.invocationCallOrder[0]).toBeLessThan(service.request.mock.invocationCallOrder[0]);
  expect(service.request).toHaveBeenCalledWith(REQUEST);
  expect(button.editReply).toHaveBeenCalledWith({
    content: "link",
    components: ["row"],
    allowedMentions: { parse: [] },
  });
  expect(button.update).not.toHaveBeenCalled();
});

it("says linking is off while the switch is off, touching nothing else", async () => {
  const env = { get: (key: string) => (key === "PATREON_LINK_ENABLED" ? false : undefined) } as unknown as EnvService;
  const untouched = new Proxy(
    {},
    {
      get: () => {
        throw new Error("Nothing else may be used while linking is off.");
      },
    },
  );
  const service = new PatronLinkService(
    env,
    ...(Array.from({ length: 10 }, () => untouched) as ConstructorParameters<typeof PatronLinkService> extends [
      unknown,
      ...infer Rest,
    ]
      ? Rest
      : never),
  );
  const button = interaction();
  await new PatronLinkComponent(service).link([button] as unknown as ButtonContext);
  expect(button.editReply).toHaveBeenCalledWith({ content: PATRON_COPY.off, allowedMentions: { parse: [] } });
});
