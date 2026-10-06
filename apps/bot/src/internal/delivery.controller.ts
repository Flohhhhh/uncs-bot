import { InternalExceptionFilter } from "./errors";
import { UseFilters } from "@nestjs/common";
import { createHash } from "node:crypto";
import { StaffAlertsDiscord } from "../staff-alerts/staff-alerts.discord";
import { statusCard } from "../server-community/community-state";
import { panelMessage, STAFF_COPY } from "../patron-link/patron-link.copy";
import { communityEditRequest, alertSendRequest, alertEditRequest, panelRequest } from "@uncs/contracts";
import { Body, Controller, Get, Post, UseGuards, ServiceUnavailableException } from "@nestjs/common";
import { ChannelType, Client, PermissionFlagsBits, DiscordAPIError } from "discord.js";
import { OperationReceipts } from "@uncs/api-client";
import {
  ballotRequest,
  channelRequest,
  memberRequest,
  roleChange,
  roleCheckRequest,
  reminderRequest,
  weeklyPostedRequest,
  weeklySendRequest,
} from "@uncs/contracts";
import { InternalGuard, parse } from "./transport";
import { DiscordRolesDiscord } from "../discord-roles/discord-roles.discord";
import { MapVotesDiscord } from "../map-votes/map-votes.discord";
import type { MapVoteRecord } from "../map-votes/map-votes.types";
import { WeeklyLeaderboardDiscord } from "../weekly-leaderboard/weekly-leaderboard.discord";

@Controller("internal/v1")
@UseGuards(InternalGuard)
@UseFilters(InternalExceptionFilter)
export class DeliveryController {
  private readonly receipts = new OperationReceipts();
  constructor(
    private readonly client: Client,
    private readonly alerts: StaffAlertsDiscord,
    private readonly roles: DiscordRolesDiscord,
    private readonly ballots: MapVotesDiscord,
    private readonly weekly: WeeklyLeaderboardDiscord,
  ) {}
  private active() {
    if (process.env.BOT_GATEWAY_ENABLED !== "true" || !this.client.isReady())
      throw new ServiceUnavailableException("Discord delivery is unavailable.");
  }
  private guild(guildId: string) {
    if (guildId !== process.env.ADMIN_GUILD_ID)
      throw new ServiceUnavailableException("Guild is not configured for this service.");
  }
  @Get("discord/ready") ready() {
    return { status: "ready", gateway: this.client.isReady() };
  }
  @Post("roles/check") check(@Body() input: unknown) {
    this.active();
    const body = parse(roleCheckRequest, input);
    this.guild(body.guildId);
    return this.roles.check(
      body.guildId,
      { member: body.roleIds.member, founder: body.roleIds.founder, supporter: body.roleIds.supporter },
      body.staffRoleIds,
      body.seederRoleId,
    );
  }
  @Post("roles/member") async member(@Body() input: unknown) {
    this.active();
    const body = parse(memberRequest, input);
    this.guild(body.guildId);
    const guild = await this.client.guilds.fetch(body.guildId);
    const member = await guild.members.fetch({ user: body.userId, force: true }).catch((error) => {
      if (error.code === 10007) return null;
      throw error;
    });
    return member
      ? {
          id: member.id,
          joinedAt: member.joinedAt?.toISOString() ?? null,
          roles: [...member.roles.cache.keys()],
          pending: member.pending,
          bot: member.user.bot,
        }
      : null;
  }
  @Post("roles/add") add(@Body() input: unknown) {
    return this.change(input, true);
  }
  @Post("roles/remove") remove(@Body() input: unknown) {
    return this.change(input, false);
  }
  private change(input: unknown, add: boolean) {
    this.active();
    const body = parse(roleChange, input);
    this.guild(body.guildId);
    return this.receipts.run(body.operationId, { ...body, add }, async () => {
      const configured = [
        process.env.DISCORD_MEMBER_ROLE_ID,
        process.env.DISCORD_FOUNDER_ROLE_ID,
        process.env.DISCORD_SUPPORTER_ROLE_ID,
      ];
      if (!configured.includes(body.roleId) || (!add && body.roleId === process.env.DISCORD_FOUNDER_ROLE_ID))
        throw new ServiceUnavailableException("Role operation is not permitted.");
      const member = await this.roles.member(body.guildId, body.userId);
      if (!member) throw new ServiceUnavailableException("Member left the guild.");
      await (add ? member.add(body.roleId, body.reason) : member.remove(body.roleId, body.reason));
      return { ok: true };
    });
  }
  @Post("ballots/channel") ballotChannel(@Body() input: unknown) {
    this.active();
    const body = parse(channelRequest, input);
    this.guild(body.guildId);
    return this.ballots.check(body.guildId, body.channelId);
  }
  private vote(input: unknown) {
    const body = parse(ballotRequest, input);
    this.guild(body.vote.guildId);
    const vote = {
      ...body.vote,
      roundStartedAt: body.vote.roundStartedAt ? new Date(body.vote.roundStartedAt) : null,
      createdAt: new Date(body.vote.createdAt),
      updatedAt: new Date(body.vote.updatedAt),
      closesAt: new Date(body.vote.closesAt),
    } as MapVoteRecord;
    return { ...body, vote };
  }
  @Post("ballots/publish") publish(@Body() input: unknown) {
    this.active();
    const body = this.vote(input);
    return this.receipts.run(body.operationId, input, () => this.ballots.publish(body.vote));
  }
  @Post("ballots/find") find(@Body() input: unknown) {
    this.active();
    return this.ballots.findBallotMessage(this.vote(input).vote);
  }
  @Post("ballots/update") update(@Body() input: unknown) {
    this.active();
    const body = this.vote(input);
    return this.receipts.run(body.operationId, input, async () => {
      await this.ballots.update(body.vote);
      return { ok: true };
    });
  }
  @Post("ballots/remind") remind(@Body() input: unknown) {
    this.active();
    const { stage, ...rest } = parse(reminderRequest, input);
    const body = this.vote(rest);
    return this.receipts.run(body.operationId, input, async () => {
      await this.ballots.remind(body.vote, stage);
      return { ok: true };
    });
  }
  @Post("weekly/channel") async weeklyChannel(@Body() input: unknown) {
    this.active();
    const body = parse(channelRequest, input);
    this.guild(body.guildId);
    const channel = await this.weekly.channel(body.guildId, body.channelId);
    return { name: channel.name };
  }
  @Post("weekly/posted") async posted(@Body() input: unknown) {
    this.active();
    const body = parse(weeklyPostedRequest, input);
    this.guild(body.guildId);
    return this.weekly.posted(
      await this.weekly.channel(body.guildId, body.channelId),
      body.slot,
      body.weekKey,
      body.serverId,
    );
  }
  @Post("weekly/send") send(@Body() input: unknown) {
    this.active();
    const body = parse(weeklySendRequest, input);
    this.guild(body.guildId);
    return this.receipts.run(body.operationId, input, async () =>
      this.weekly.send(
        await this.weekly.channel(body.guildId, body.channelId),
        { ...body.payload, allowedMentions: { parse: [], users: [], roles: [], repliedUser: false } },
        body.nonce,
      ),
    );
  }
  @Get("alerts/channel") async alertsChannel() {
    const check = await this.alerts.channelCheck();
    return {
      state: check.state,
      channelId: check.channel?.id ?? null,
      ping: check.channel ? this.alerts.pingReady(check.channel) : this.alerts.pingState(),
    };
  }
  @Post("alerts/send") alertSend(@Body() input: unknown) {
    this.active();
    const body = parse(alertSendRequest, input);
    return this.receipts.run(body.operationId, input, async () => {
      const check = await this.alerts.channelCheck();
      if (!check.channel || check.state !== "ok")
        throw new ServiceUnavailableException("Staff channel is unavailable.");
      const role = process.env.STAFF_ALERTS_PING_ROLE_ID;
      const ping = body.ping && this.alerts.pingReady(check.channel) === "ok" && !!role;
      const message = await check.channel.send({
        embeds: [this.alerts.embed(body.record)],
        allowedMentions: { parse: [], users: [], roles: ping ? [role] : [], repliedUser: false },
        nonce: createHash("sha256").update(`gramps-staff-alert:${body.record.id}`).digest("hex").slice(0, 25),
        enforceNonce: true,
        ...(ping ? { content: `<@&${role}>` } : {}),
      });
      return message.id;
    });
  }
  @Post("alerts/edit") alertEdit(@Body() input: unknown) {
    this.active();
    const body = parse(alertEditRequest, input);
    return this.receipts.run(body.operationId, input, async () => {
      const check = await this.alerts.channelCheck();
      if (!check.channel) throw new ServiceUnavailableException("Staff channel is unavailable.");
      const message = await check.channel.messages.fetch(body.messageId);
      if (message.author.id !== this.client.user!.id)
        throw new ServiceUnavailableException("Message author does not match.");
      await message.edit({ embeds: [this.alerts.embed(body.record, body.note)] });
      return { ok: true };
    });
  }
  @Post("community/edit") community(@Body() input: unknown) {
    this.active();
    const body = parse(communityEditRequest, input);
    this.guild(body.guildId);
    return this.receipts.run(body.operationId, input, async () => {
      const channel = await this.client.channels.fetch(body.channelId);
      if (!channel || !("guildId" in channel) || channel.guildId !== body.guildId || !("messages" in channel))
        throw new ServiceUnavailableException("Status channel is unavailable.");
      const message = await channel.messages.fetch(body.messageId);
      if (message.author.id !== this.client.user!.id)
        throw new ServiceUnavailableException("Status message author does not match.");
      await message.edit(statusCard(body.snapshot, body.online) as Parameters<typeof message.edit>[0]);
      return { ok: true };
    });
  }
  @Post("patreon/panel") patronPanel(@Body() input: unknown) {
    this.active();
    const body = parse(panelRequest, input);
    this.guild(body.guildId);
    return this.receipts.run(body.operationId, input, async () => {
      const channel = await this.client.channels.fetch(body.channelId);
      if (
        !channel ||
        (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) ||
        channel.guildId !== body.guildId
      )
        return STAFF_COPY.channel;
      const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe());
      if (!channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))
        return STAFF_COPY.channel;
      try {
        await channel.send({
          ...panelMessage(),
          nonce: createHash("sha256").update(body.operationId).digest("hex").slice(0, 24),
          enforceNonce: true,
        });
        return STAFF_COPY.posted;
      } catch (error) {
        return error instanceof DiscordAPIError && error.status >= 400 && error.status < 500
          ? STAFF_COPY.refused
          : STAFF_COPY.unknown;
      }
    });
  }
}
