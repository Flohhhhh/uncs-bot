import { InternalExceptionFilter } from "./errors";
import { UseFilters } from "@nestjs/common";
import { Body, Controller, Get, Post, UseGuards, ForbiddenException, Param, Module } from "@nestjs/common";
import { z } from "zod";
import { OperationReceipts } from "@uncs/api-client";
import {
  interactionContext,
  memberRequest,
  welcomeWrite,
  voteCastRequest,
  type InteractionContext,
} from "@uncs/contracts";
import { InternalGuard, parse, TransportModule } from "./transport";
import { AdminSettings } from "../admin/admin.settings";
import { AdminModule } from "../admin/admin.module";
import { EnvService } from "../env/env.service";
import { staffRoleFor } from "../common/admin-policy";
import { WelcomeModule } from "../welcome/welcome.module";
import { WelcomeService } from "../welcome/welcome.service";
import { MapVotesModule } from "../map-votes/map-votes.module";
import { MapVotesService } from "../map-votes/map-votes.service";
import { DiscordRolesModule } from "../discord-roles/discord-roles.module";
import { DiscordRolesService } from "../discord-roles/discord-roles.service";
import { PatronLinkModule } from "../patron-link/patron-link.module";
import { PatronLinkService } from "../patron-link/patron-link.service";
import { GameServers } from "../admin/game-servers";

const member = z.object({
  roles: z.array(z.string()),
  pending: z.boolean().optional(),
  user: z.object({ id: z.string(), bot: z.boolean().optional() }),
});
const role = z.object({ id: z.string(), permissions: z.string().regex(/^\d+$/) });
@Controller("internal/v1")
@UseGuards(InternalGuard)
@UseFilters(InternalExceptionFilter)
export class BusinessController {
  private readonly receipts = new OperationReceipts();
  constructor(
    private readonly settings: AdminSettings,
    private readonly env: EnvService,
    private readonly welcome: WelcomeService,
    private readonly votes: MapVotesService,
    private readonly roles: DiscordRolesService,
    private readonly patron: PatronLinkService,
    private readonly servers: GameServers,
  ) {}
  private async discord<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      headers: { authorization: `Bot ${this.env.get("DISCORD_BOT_TOKEN")}` },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new ForbiddenException("Discord membership could not be verified.");
    return parse(schema, await response.json());
  }
  private async actor(context: InteractionContext, configuredGuild = true) {
    if (configuredGuild && context.guildId !== this.env.get("ADMIN_GUILD_ID"))
      throw new ForbiddenException("Guild is not configured.");
    const value = await this.discord(`/guilds/${context.guildId}/members/${context.userId}`, member);
    if (value.user.id !== context.userId || value.user.bot || value.pending)
      throw new ForbiddenException("Only screened community members can use this operation.");
    return value;
  }
  private active() {
    if (process.env.API_MUTATIONS_ENABLED !== "true")
      throw new ForbiddenException("Operational mutations are disabled.");
  }
  @Get("welcome/:guildId") welcomeRead(@Param("guildId") guildId: string) {
    parse(z.string().regex(/^\d{17,20}$/), guildId);
    return this.welcome.getSettings(guildId);
  }
  @Post("welcome/settings") async welcomeWrite(@Body() input: unknown) {
    this.active();
    const body = parse(welcomeWrite, input);
    const actor = await this.actor(body.context, false);
    const guild = await this.discord(`/guilds/${body.context.guildId}`, z.object({ owner_id: z.string() }));
    const roles = await this.discord(`/guilds/${body.context.guildId}/roles`, z.array(role));
    const permissions = roles
      .filter((role) => role.id === body.context.guildId || actor.roles.includes(role.id))
      .reduce((all, role) => all | BigInt(role.permissions), 0n);
    if (guild.owner_id !== body.context.userId && !(permissions & (1n << 5n)) && !(permissions & (1n << 3n)))
      throw new ForbiddenException("Manage Server permission is required.");
    return this.receipts.run(body.context.interactionId, body, () =>
      body.enabled !== undefined
        ? this.welcome.setEnabled(body.context.guildId, body.enabled)
        : this.welcome.setMessage(body.context.guildId, body.message!),
    );
  }
  @Post("votes/cast") async cast(@Body() input: unknown) {
    this.active();
    const body = parse(voteCastRequest, input);
    await this.actor(body.context);
    return this.receipts.run(body.context.interactionId, body, () =>
      this.votes.cast(
        body.id,
        body.choice,
        body.context.userId,
        body.context.guildId,
        body.context.channelId!,
        body.messageId,
        true,
      ),
    );
  }
  @Post("roles/member-joined") async joined(@Body() input: unknown) {
    const body = parse(memberRequest, input);
    if (process.env.API_WORKERS_ENABLED === "true") this.roles.memberJoined(body.guildId, body.userId);
    return { ok: true };
  }
  @Get("seeding/context") async seeding() {
    const list = this.servers.list();
    const target = list.find((server) => server.id === "primary") ?? list[0];
    let players: { current: number; max: number } | null = null;
    if (target) {
      try {
        players = (await this.servers.get(target.id).overview()).status.players;
      } catch {
        /* Game availability is independent from Discord metadata. */
      }
    }
    return {
      policy: this.settings.staffPolicy(),
      server: target ? { id: target.id, name: target.name, joinId: target.joinId ?? null, players } : null,
    };
  }
  @Post("seeding/authorize") async authorize(@Body() input: unknown) {
    const context = parse(interactionContext, input);
    const actor = await this.actor(context);
    const staff = staffRoleFor(context.userId, actor.roles, this.settings.staffPolicy());
    if (!staff || staff === "viewer") throw new ForbiddenException("Staff access is required.");
    return { ok: true };
  }
  @Post("patreon/request") async patronRequest(@Body() input: unknown) {
    this.active();
    const context = parse(interactionContext, input);
    const actor = await this.actor(context);
    return this.receipts.run(context.interactionId, context, () =>
      this.patron.request({ ...context, bot: false, roles: actor.roles }),
    );
  }
  @Post("patreon/panel") async patronPanel(@Body() input: unknown) {
    this.active();
    const context = parse(interactionContext, input);
    const actor = await this.actor(context);
    if (staffRoleFor(context.userId, actor.roles, this.settings.staffPolicy()) !== "admin")
      throw new ForbiddenException("Administrator access is required.");
    return this.receipts.run(context.interactionId, context, () =>
      this.patron.panel({ ...context, bot: false, roles: actor.roles }),
    );
  }
}
@Module({
  imports: [TransportModule, AdminModule, WelcomeModule, MapVotesModule, DiscordRolesModule, PatronLinkModule],
  controllers: [BusinessController],
})
export class BusinessModule {}
