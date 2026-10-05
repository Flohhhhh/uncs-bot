import { Injectable } from "@nestjs/common";
import { InteractionContextType, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { Context, createCommandGroupDecorator, Subcommand, type SlashCommandContext } from "necord";
import { PatronLinkService, patronLinkRequest, type PatronLinkReply } from "./patron-link.service";

const PatreonGroup = createCommandGroupDecorator({
  name: "patreon",
  description: "Link your Patreon to Discord for your supporter roles",
  contexts: [InteractionContextType.Guild],
});

/**
 * /patreon link is open to everyone. /patreon panel checks for the dashboard's admins in the service, because one
 * command's defaultMemberPermissions would hide link too. Every reply is private and mentions nobody. Registered only
 * while PATREON_LINK_ENABLED is on (see PatronLinkCommandsModule).
 */
@Injectable()
@PatreonGroup()
export class PatronLinkCommand {
  constructor(private readonly patronLink: PatronLinkService) {}

  @Subcommand({ name: "link", description: "Link your Patreon to this Discord account" })
  async handleLink(@Context() [interaction]: SlashCommandContext) {
    return this.answer(interaction, () => this.patronLink.request(patronLinkRequest(interaction)));
  }

  @Subcommand({ name: "panel", description: "Admins: post the Link Patreon button here" })
  async handlePanel(@Context() [interaction]: SlashCommandContext) {
    return this.answer(interaction, async () => ({
      content: await this.patronLink.panel(patronLinkRequest(interaction)),
    }));
  }

  private async answer(interaction: ChatInputCommandInteraction, work: () => Promise<PatronLinkReply>) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return interaction.editReply({ ...(await work()), allowedMentions: { parse: [] } });
  }
}
