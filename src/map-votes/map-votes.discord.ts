import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, PermissionFlagsBits } from "discord.js";
import { plainLabel } from "../server-community/community-state";
import { createHash } from "node:crypto";
import { hasVoteCounts, type MapVoteRecord } from "./map-votes.types";
import { mapLabel, selectionDetails } from "../common/map-labels";
import { voteChoiceTitle, type VoteReminder } from "../common/voting-policy";

export function ballotMessage(vote: MapVoteRecord) {
  const open = vote.state === "open";
  const counted = hasVoteCounts(vote);
  const choices = vote.choices.map(
    (choice, index) =>
      `${index + 1}. ${plainLabel(mapLabel(choice.map), 80)}${counted ? ` — ${vote.counts[index] ?? 0} votes` : ""}\n   ${plainLabel(selectionDetails(choice), 150)}`,
  );
  const winner =
    vote.winner === null ? "" : `\nWinner: ${plainLabel(voteChoiceTitle(vote.choices[vote.winner]), 150)}.`;
  return {
    content: `**Next map · ${plainLabel(vote.serverName)}**\n${choices.join("\n")}\n\n${
      open
        ? `${vote.automation ? "Closes when the leading team reaches 95 points (100-point match)." : `Closes <t:${Math.floor(vote.closesAt.getTime() / 1000)}:R>.`} One vote per Discord member; choosing again changes your vote. A tie or no votes keeps the rotation.\nThe winning map and mode queue only if the match and settings still match. Staff can override the choice.`
        : `${winner}\n${plainLabel(vote.message, 350)}`
    }`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        vote.choices.map((choice, index) =>
          new ButtonBuilder()
            .setCustomId(`uncs-map-vote/${vote.id}/${index}`)
            .setLabel(`${index + 1}. ${voteChoiceTitle(choice)}`.slice(0, 80))
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
    const channel = await this.channel({ guildId, channelId });
    return { name: channel.name };
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
  async remind(vote: MapVoteRecord, stage: VoteReminder) {
    const channel = await this.channel(vote);
    const choices = vote.choices.map(
      (choice, index) => `${index + 1}. ${plainLabel(voteChoiceTitle(choice), 120)} — ${vote.counts[index] ?? 0} votes`,
    );
    const total = vote.counts.reduce((sum, count) => sum + count, 0);
    await channel.send({
      content: `**${stage === "final" ? "Last chance to vote" : "Next round vote update"} · ${plainLabel(vote.serverName)}**\n${choices.join("\n")}\n\n${total} votes so far. You can change your vote. Closes at 95 points.\nhttps://discord.com/channels/${vote.guildId}/${vote.channelId}/${vote.messageId}`,
      allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
      nonce: createHash("sha256").update(`${vote.id}:${stage}`).digest("hex").slice(0, 24),
      enforceNonce: true,
    });
  }
  async update(vote: MapVoteRecord) {
    if (!vote.messageId) return;
    const channel = await this.channel(vote);
    const message = await channel.messages.fetch(vote.messageId);
    if (message.author.id !== this.discord.user!.id) throw new Error("Ballot author does not match.");
    await message.edit(ballotMessage(vote));
  }
}
