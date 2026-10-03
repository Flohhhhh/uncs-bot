import { Injectable } from "@nestjs/common";
import { InteractionContextType, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import {
  Context,
  createCommandGroupDecorator,
  Options,
  StringOption,
  Subcommand,
  type SlashCommandContext,
} from "necord";
import { SEEDING_NOTE_MAX_LENGTH } from "../../seeding/seeding-copy";
import { SeedingService, seedingRequest } from "../../seeding/seeding.service";

class SeedingPingOptions {
  @StringOption({
    name: "note",
    description: "Optional short note for seeders: one line, no mentions",
    required: false,
    max_length: SEEDING_NOTE_MAX_LENGTH,
  })
  note?: string;
}

const SeedingGroup = createCommandGroupDecorator({
  name: "seeding",
  description: "Get a ping when the WARDOGS server needs seeders",
  contexts: [InteractionContextType.Guild],
});

/**
 * join and leave are open to every member. panel, ping and status check for staff in the service, because one
 * command's defaultMemberPermissions would hide join and leave too. Every reply is private.
 */
@Injectable()
@SeedingGroup()
export class SeedingCommand {
  constructor(private readonly seeding: SeedingService) {}

  @Subcommand({
    name: "join",
    description: "Get the Seeder role: staff may ping you when the WARDOGS server is quiet",
  })
  async handleJoin(@Context() [interaction]: SlashCommandContext) {
    return this.answer(interaction, () => this.seeding.join(seedingRequest(interaction)));
  }

  @Subcommand({
    name: "leave",
    description: "Drop the Seeder role and stop seeding pings",
  })
  async handleLeave(@Context() [interaction]: SlashCommandContext) {
    return this.answer(interaction, () => this.seeding.leave(seedingRequest(interaction)));
  }

  @Subcommand({
    name: "panel",
    description: "Staff: post the opt-in and opt-out seeding buttons in this channel",
  })
  async handlePanel(@Context() [interaction]: SlashCommandContext) {
    return this.answer(interaction, () => this.seeding.panel(seedingRequest(interaction)));
  }

  @Subcommand({
    name: "ping",
    description: "Staff: ping the Seeder role to help fill the WARDOGS server",
  })
  async handlePing(@Context() [interaction]: SlashCommandContext, @Options() { note }: SeedingPingOptions) {
    return this.answer(interaction, () => this.seeding.ping(seedingRequest(interaction), note));
  }

  @Subcommand({
    name: "status",
    description: "Staff: check the seeding setup, Seeder count and ping cooldown",
  })
  async handleStatus(@Context() [interaction]: SlashCommandContext) {
    return this.answer(interaction, () => this.seeding.status(seedingRequest(interaction)));
  }

  private async answer(interaction: ChatInputCommandInteraction, work: () => Promise<string>) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return interaction.editReply({ content: await work(), allowedMentions: { parse: [] } });
  }
}
