import { MessageFlags } from "discord.js";
import type { ButtonContext } from "necord";
import type { RemoteService } from "../../../../src/internal/transport";
import { PATRON_COPY } from "../../../../src/patron-link/patron-link.copy";
import { PatronLinkService } from "../../../../src/patron-link/patron-link.service";
import { PatronLinkComponent } from "../../../../src/components/handlers/patron-link.component";

const REQUEST = {
  guildId: "200000000000000001",
  channelId: "400000000000000002",
  userId: "500000000000000001",
  interactionId: "600000000000000001",
};

function interaction() {
  return {
    id: REQUEST.interactionId,
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

it("preserves the API disabled-link reply without changing the panel", async () => {
  const remote = { request: jest.fn().mockResolvedValue({ content: PATRON_COPY.off }) };
  const service = new PatronLinkService(remote as unknown as RemoteService);
  const button = interaction();
  await new PatronLinkComponent(service).link([button] as unknown as ButtonContext);
  expect(button.editReply).toHaveBeenCalledWith({ content: PATRON_COPY.off, allowedMentions: { parse: [] } });
});
