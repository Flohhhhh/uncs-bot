import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, PermissionFlagsBits } from "discord.js";
import { plainLabel } from "../server-community/community-state";
import { createHash } from "node:crypto";
import { hasVoteCounts, type MapVoteRecord } from "./map-votes.types";
import { mapLabel, selectionDetails } from "../common/map-labels";
import { automationSettings, voteChoiceTitle, type VoteReminder } from "../common/voting-policy";

const ballotPrefix = (id: string) => `uncs-map-vote/${id}/`;
function closingRule(vote: MapVoteRecord) {
  if (!vote.automation) return `Closes <t:${Math.floor(vote.closesAt.getTime() / 1000)}:R>.`;
  const close = automationSettings(vote.automation).closeAtScore;
  return `Closes when the leading team reaches ${close} points (100-point match).`;
}
function tieRule(vote: MapVoteRecord) {
  return vote.automation && automationSettings(vote.automation).tieRule === "first_option"
    ? "A tie goes to the first tied option (never 50v50); no votes keeps the rotation."
    : "A tie or no votes keeps the rotation.";
}
/** What a 50v50 option does, from the settings the ballot opened with. */
function fiftyDetails(vote: MapVoteRecord) {
  const fifty = automationSettings(vote.automation ?? {}).fiftyFifty;
  const closed = fifty.closedFaction ? plainLabel(fifty.closedFaction, 30) : "the smallest team";
  const end = fifty.autoEnd
    ? `ends after ${fifty.rounds} round${fifty.rounds === 1 ? "" : "s"}`
    : "runs until staff stop it";
  return `Next round as two teams of up to 50; ${closed} is closed and its players are moved at round start; ${end}.`;
}

export function ballotMessage(vote: MapVoteRecord) {
  const open = vote.state === "open";
  const counted = hasVoteCounts(vote);
  const choices = vote.choices.map(
    (choice, index) =>
      `${index + 1}. ${choice.event === "50v50" ? "50v50 · " : ""}${plainLabel(mapLabel(choice.map), 80)}${
        counted ? ` — ${vote.counts[index] ?? 0} votes` : ""
      }\n   ${choice.event === "50v50" ? fiftyDetails(vote) : plainLabel(selectionDetails(choice), 150)}`,
  );
  const winner =
    vote.winner === null ? "" : `\nWinner: ${plainLabel(voteChoiceTitle(vote.choices[vote.winner]), 150)}.`;
  const next = vote.automation?.rotation?.nextLabel;
  return {
    content: `**Next round · ${plainLabel(vote.serverName)}**\n${choices.join("\n")}${
      next ? `\nRotation next: ${plainLabel(next, 80)}` : ""
    }\n\n${
      open
        ? `${closingRule(vote)} One vote per Discord member; choosing again changes your vote. ${tieRule(vote)}\nThe winning map and mode queue only if the match and settings still match. Staff can override the choice.`
        : `${winner}\n${plainLabel(vote.message, 350)}`
    }`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        vote.choices.map((choice, index) =>
          new ButtonBuilder()
            .setCustomId(`${ballotPrefix(vote.id)}${index}`)
            .setLabel(`${index + 1}. ${voteChoiceTitle(choice)}`.slice(0, 80))
            .setStyle(choice.event === "50v50" ? ButtonStyle.Danger : ButtonStyle.Secondary)
            .setDisabled(!open),
        ),
      ),
    ],
    allowedMentions: { parse: [] as [], users: [], roles: [], repliedUser: false },
  };
}
/** Every component custom ID in a message's serialized rows. */
function customIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(customIds);
  if (!value || typeof value !== "object") return [];
  const item = value as { custom_id?: unknown; components?: unknown };
  return [...(typeof item.custom_id === "string" ? [item.custom_id] : []), ...customIds(item.components)];
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
  /** Finds this bot's ballot message among the channel's latest 50 messages, without posting. */
  async findBallotMessage(vote: MapVoteRecord) {
    const channel = await this.channel(vote);
    const messages = await channel.messages.fetch({ limit: 50 });
    const found = [...messages.values()].find(
      (message) =>
        message.author.id === this.discord.user!.id &&
        customIds(message.components.map((row) => row.toJSON())).some((id) => id.startsWith(ballotPrefix(vote.id))),
    );
    return found?.id ?? null;
  }
  async remind(vote: MapVoteRecord, stage: VoteReminder) {
    const channel = await this.channel(vote);
    const choices = vote.choices.map(
      (choice, index) => `${index + 1}. ${plainLabel(voteChoiceTitle(choice), 120)} — ${vote.counts[index] ?? 0} votes`,
    );
    const total = vote.counts.reduce((sum, count) => sum + count, 0);
    const close = vote.automation ? automationSettings(vote.automation).closeAtScore : 95;
    await channel.send({
      content: `**${stage === "final" ? "Last chance to vote" : "Next round vote update"} · ${plainLabel(vote.serverName)}**\n${choices.join("\n")}\n\n${total} votes so far. You can change your vote. Closes at ${close} points.\nhttps://discord.com/channels/${vote.guildId}/${vote.channelId}/${vote.messageId}`,
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
