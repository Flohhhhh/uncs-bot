import { Injectable } from "@nestjs/common";
import { MessageFlags } from "discord.js";
import { Button, Context, type ButtonContext } from "necord";
import { PATRON_LINK_BUTTON } from "../../patron-link/patron-link.copy";
import { PatronLinkService, patronLinkRequest } from "../../patron-link/patron-link.service";

/**
 * The Link Patreon button on the panel admins post with /patreon panel. It does exactly what /patreon link does, and
 * it stays registered while linking is off, so a panel already posted says so instead of failing.
 */
@Injectable()
export class PatronLinkComponent {
  constructor(private readonly patronLink: PatronLinkService) {}

  @Button(PATRON_LINK_BUTTON)
  async link(@Context() [interaction]: ButtonContext) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({
      ...(await this.patronLink.request(patronLinkRequest(interaction))),
      allowedMentions: { parse: [] },
    });
  }
}
