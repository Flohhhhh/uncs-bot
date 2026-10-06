import { Injectable } from "@nestjs/common";
import { MessageFlags, type ButtonInteraction } from "discord.js";
import { Button, Context, type ButtonContext } from "necord";
import { SEEDING_BUTTONS } from "../../seeding/seeding-copy";
import { SeedingService, seedingRequest } from "../../seeding/seeding.service";

/** The buttons on the panel staff post with /seeding panel. They do exactly what /seeding join and leave do. */
@Injectable()
export class SeedingComponent {
  constructor(private readonly seeding: SeedingService) {}

  @Button(SEEDING_BUTTONS.join)
  async join(@Context() [interaction]: ButtonContext) {
    await this.answer(interaction, () => this.seeding.join(seedingRequest(interaction)));
  }

  @Button(SEEDING_BUTTONS.leave)
  async leave(@Context() [interaction]: ButtonContext) {
    await this.answer(interaction, () => this.seeding.leave(seedingRequest(interaction)));
  }

  private async answer(interaction: ButtonInteraction, work: () => Promise<string>) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({ content: await work(), allowedMentions: { parse: [] } });
  }
}
