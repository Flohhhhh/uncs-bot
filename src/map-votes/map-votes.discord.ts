import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, PermissionFlagsBits } from "discord.js";
import { plainLabel } from "../server-community/community-state";
import { createHash } from "node:crypto";
import type { MapVoteRecord } from "./map-votes.types";

export function ballotMessage(vote: MapVoteRecord) {
  const open = vote.state === "open";
  const choices = vote.choices.map(
    (choice, index) =>
      `${index + 1}. ${plainLabel(choice.map, 80)}${open ? "" : ` — ${vote.counts[index] ?? 0} votes`}\n   ${plainLabel([...choice.experiences, choice.lighting, choice.zoneAlternator].filter(Boolean).join(", ") || "Map defaults", 150)}`,
  );
  const winner =
    vote.winner === null ? "" : `\nWinner: ${plainLabel(vote.choices[vote.winner]?.map ?? "Unknown", 80)}.`;
  return {
    content: `**Next map · ${plainLabel(vote.serverName)}**\n${choices.join("\n")}\n\n${
      open
        ? `Closes <t:${Math.floor(vote.closesAt.getTime() / 1000)}:R>. One vote per Discord member; choosing again changes your vote. Ties use the first listed option. No votes keeps the rotation.\nThe winner queues only if the round and settings still match.`
        : `${winner}\n${plainLabel(vote.message, 350)}`
    }`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        vote.choices.map((choice, index) =>
          new ButtonBuilder()
            .setCustomId(`uncs-map-vote/${vote.id}/${index}`)
            .setLabel(`${index + 1}. ${choice.map}`.slice(0, 80))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!open),
        ),
      ),
    ],
    allowedMentions: { parse: [] as [], users: [], roles: [], repliedUser: false },
  };
}

@Injectable()
export class MapVotesDiscord {
  constructor(private readonly discord: Client) {}
  private async channel(vote: Pick<MapVoteRecord, "guildId" | "channelId">) {
    if (!this.discord.isReady()) throw new ServiceUnavailableException("Discord is not ready for a ballot.");
    const channel = await this.discord.channels.fetch(vote.channelId);
    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      channel.guildId !== vote.guildId ||
      !channel
        .permissionsFor(this.discord.user!)
        ?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ])
    )
      throw new ServiceUnavailableException(
        "Choose a text channel in this community that the bot can read and post in.",
      );
    return channel;
  }
  async check(guildId: string, channelId: string) {
    await this.channel({ guildId, channelId });
  }
  async publish(vote: MapVoteRecord) {
    const channel = await this.channel(vote);
    // Never retry an uncertain send. A stored publishing record survives a lost response.
    const message = await channel.send({
      ...ballotMessage({ ...vote, state: "open" }),
      nonce: createHash("sha256").update(vote.id).digest("hex").slice(0, 24),
      enforceNonce: true,
    });
    return message.id;
  }
  async update(vote: MapVoteRecord) {
    if (!vote.messageId) return;
    const channel = await this.channel(vote);
    const message = await channel.messages.fetch(vote.messageId);
    if (message.author.id !== this.discord.user!.id) throw new Error("Ballot author does not match.");
    await message.edit(ballotMessage(vote));
  }
}
