/**
 * Gets information about a user, role, or member in the server.
 *
 * This command demonstrates the use of non-primitive options in a slash command, specifically the Mentionable option type.
 */
import { Injectable, Logger } from "@nestjs/common";
import { EmbedBuilder, GatewayIntentBits, GuildMember, Role, User } from "discord.js";
import { Context, MentionableOption, Options, SlashCommand, type SlashCommandContext } from "necord";

/** Discord rejects embed field values longer than this. */
const FIELD_VALUE_LIMIT = 1024;

/** Joins role names, leaving out as many as needed to fit one embed field and saying how many were left out. */
function listRoles(names: string[]): string {
  if (names.length === 0) return "None";
  const all = names.join(", ");
  if (all.length <= FIELD_VALUE_LIMIT) return all;
  let value = "";
  let shown = 0;
  for (const name of names) {
    const next = value ? `${value}, ${name}` : name;
    const left = names.length - shown - 1;
    if (next.length + (left > 0 ? `, and ${left} more`.length : 0) > FIELD_VALUE_LIMIT) break;
    value = next;
    shown++;
  }
  const hidden = names.length - shown;
  return hidden > 0 ? `${value}, and ${hidden} more` : value;
}

class WhatisOptions {
  @MentionableOption({
    name: "thing",
    description: "The thing to get info about",
    required: true,
    name_localizations: {
      fr: "chose",
    },
  })
  thing?: GuildMember | Role | User;
}

@Injectable()
export class WhatisCommand {
  private readonly logger = new Logger(WhatisCommand.name);

  @SlashCommand({
    name: "whatis",
    description: "Example command",
  })
  async handleWhatis(@Context() [interaction]: SlashCommandContext, @Options() { thing }: WhatisOptions) {
    const embed = new EmbedBuilder();
    if (thing instanceof GuildMember) {
      embed
        .setTitle(`Member: ${thing.user.displayName}`)
        .setThumbnail(thing.user.displayAvatarURL())
        .addFields(
          { name: "ID", value: thing.id, inline: true },
          { name: "Mention", value: `<@${thing.id}>`, inline: true },
          { name: "Joined At", value: thing.joinedAt?.toDateString() ?? "Unknown", inline: true },
          {
            name: "Roles",
            value: listRoles(
              thing.roles.cache
                .filter((r) => r.id !== thing.guild.id)
                .sort((a, b) => b.position - a.position)
                .map((r) => r.name),
            ),
          },
        );
    } else if (thing instanceof Role) {
      // Loading the member list for an exact count can take longer than Discord's 3 second reply window.
      await interaction.deferReply();
      const members = await this.countRoleMembers(thing);
      embed
        .setTitle(`Role: ${thing.name}`)
        .addFields(
          { name: "ID", value: thing.id, inline: true },
          { name: "Mention", value: `<@&${thing.id}>`, inline: true },
          { name: "Color", value: thing.hexColor, inline: true },
          { name: "Members", value: members, inline: true },
          { name: "Mentionable", value: thing.mentionable ? "Yes" : "No", inline: true },
        )
        .setColor(thing.color);
    } else if (thing instanceof User) {
      embed
        .setTitle(`User: ${thing.tag}`)
        .setThumbnail(thing.displayAvatarURL())
        .addFields(
          { name: "ID", value: thing.id, inline: true },
          { name: "Mention", value: `<@${thing.id}>`, inline: true },
          { name: "Bot", value: thing.bot ? "Yes" : "No", inline: true },
          { name: "Created At", value: thing.createdAt.toDateString(), inline: true },
        );
    } else {
      embed.setDescription("Unknown mentionable type.");
    }
    if (interaction.deferred) await interaction.editReply({ embeds: [embed] });
    else await interaction.reply({ embeds: [embed] });
  }

  /**
   * `Role#members` only sees cached members, and the bot does not cache everyone at startup. Load the full member
   * list first when the GuildMembers intent allows it, and otherwise present the cached count as a minimum.
   */
  private async countRoleMembers(role: Role): Promise<string> {
    const { guild } = role;
    const complete = guild.members.cache.size >= guild.memberCount || (await this.fetchAllMembers(role));
    return complete ? `${role.members.size}` : `At least ${role.members.size} (not every member is loaded)`;
  }

  private async fetchAllMembers({ guild }: Role): Promise<boolean> {
    if (!guild.client.options.intents.has(GatewayIntentBits.GuildMembers)) return false;
    try {
      await guild.members.fetch({ time: 10_000 });
      return true;
    } catch (error) {
      this.logger.warn(`Could not load the member list for guild ${guild.id}: ${String(error)}`);
      return false;
    }
  }
}
