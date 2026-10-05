import { Injectable, Logger } from "@nestjs/common";
import {
  ChannelType,
  Client,
  DiscordAPIError,
  PermissionFlagsBits,
  type NewsChannel,
  type TextChannel,
} from "discord.js";
import { createHash } from "node:crypto";
import { AdminSettings } from "../admin/admin.settings";
import { staffRoleFor } from "../common/admin-policy";
import { DiscordRolesService } from "../discord-roles/discord-roles.service";
import { EnvService } from "../env/env.service";
import { patreonCampaign } from "../supporters/founder-policy";
import { PatreonClient, type PatreonMemberResult } from "../supporters/patreon.client";
import { deploymentSecrets, PatreonSyncService } from "../supporters/patreon-sync.service";
import { SupporterMatchService } from "../supporters/supporter-match.service";
import { SupportersStore } from "../supporters/supporters.store";
import {
  isPatronLinkOutcome,
  issuedReply,
  panelMessage,
  PATRON_COPY,
  READINESS_COPY,
  resultPage,
  STAFF_COPY,
  type PatronLinkOutcome,
} from "./patron-link.copy";
import { PATRON_LINK_PATHS, PatronLinkCallError, PatronLinkOAuth, type PatronLinkClients } from "./patron-link.oauth";
import { PatronLinkState } from "./patron-link.state";
import { PatronLinkStore } from "./patron-link.store";

/** The only two lines "Link Patreon" logs. Neither names an account, code, state or token. */
export const PATRON_LINK_FINISHED = (outcome: PatronLinkOutcome) => `Patron link finished: ${outcome}`;
export const PATRON_LINK_FAILED = "Patron link failed. Nothing was linked.";

/** Who asked in Discord: the interaction's guild (null in DMs), channel, user and the member's role IDs. */
export type PatronLinkRequest = {
  guildId: string | null;
  channelId: string | null;
  userId: string;
  bot: boolean;
  roles: readonly string[];
};
/** A Discord member's roles arrive as a role manager (cached member) or as plain IDs (API member). */
function roleIds(member: unknown): string[] {
  const roles = member && typeof member === "object" && "roles" in member ? member.roles : undefined;
  if (Array.isArray(roles)) return roles.filter((role): role is string => typeof role === "string");
  if (roles && typeof roles === "object" && "cache" in roles && roles.cache instanceof Map)
    return [...(roles.cache as Map<string, unknown>).keys()];
  return [];
}
export function patronLinkRequest(interaction: {
  guildId: string | null;
  channelId: string | null;
  user: { id: string; bot: boolean };
  member: unknown;
}): PatronLinkRequest {
  return {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    bot: interaction.user.bot,
    roles: roleIds(interaction.member),
  };
}

export type PatronLinkReply = { content: string; components?: ReturnType<typeof issuedReply>["components"] };
/** Where a sign-in goes next: a finished outcome (shown on the result page), or a provider's page. */
export type PatronLinkStep = { outcome: PatronLinkOutcome } | { location: string; flowId?: string };

type Settings = PatronLinkClients & { campaignId: string; creatorToken: string };
type PanelChannel = TextChannel | NewsChannel;

const validCode = (code: unknown) =>
  typeof code === "string" && code.length >= 1 && code.length <= 2048 ? code : null;
/** A message nonce (Discord allows at most 25 characters) that stays the same if the REST client resends. */
const nonce = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 24);
/** Discord answered with a 4xx error, so nothing was posted. Anything else is uncertain. */
const refused = (error: unknown) => error instanceof DiscordAPIError && error.status >= 400 && error.status < 500;

/**
 * "Link Patreon": a patron asks in Discord, signs in to Discord (which must be the same account) and then Patreon, and
 * Gramps links the Patreon membership to that Discord account. Roles follow through the role service and automatic
 * matching, as for any other link. Off by default (PATREON_LINK_ENABLED). Discord replies are private and mention
 * nobody, nothing is sent by DM, and the patron's Patreon login is used once and never kept.
 */
@Injectable()
export class PatronLinkService {
  private readonly logger = new Logger("PatronLink");

  constructor(
    private readonly env: EnvService,
    private readonly admin: AdminSettings,
    private readonly sync: PatreonSyncService,
    private readonly patreon: PatreonClient,
    private readonly supporters: SupportersStore,
    private readonly store: PatronLinkStore,
    private readonly state: PatronLinkState,
    private readonly oauth: PatronLinkOAuth,
    private readonly roles: DiscordRolesService,
    private readonly match: SupporterMatchService,
    private readonly discord: Client,
  ) {}

  enabled() {
    return this.env.get("PATREON_LINK_ENABLED") === true;
  }

  /** The first setting that keeps linking from working, in staff-facing words, or null when it is ready. */
  readiness(): string | null {
    if (!this.sync.configured()) return READINESS_COPY.import;
    const clientId = this.env.get("PATREON_CLIENT_ID");
    if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(clientId)) return READINESS_COPY.clientId;
    const secret = this.env.get("PATREON_CLIENT_SECRET");
    if (
      typeof secret !== "string" ||
      !/^[\x21-\x7e]{16,512}$/.test(secret) ||
      [
        this.env.get("PATREON_CREATOR_ACCESS_TOKEN"),
        this.env.get("PATREON_WEBHOOK_SECRET"),
        ...deploymentSecrets(this.env, { clientSecret: false }),
      ].includes(secret)
    )
      return READINESS_COPY.clientSecret;
    try {
      this.admin.patronLink();
    } catch {
      return READINESS_COPY.signIn;
    }
    if (!this.env.get("DISCORD_ROLES_ENABLED") || !this.env.get("DISCORD_SUPPORTER_ROLE_ID"))
      return READINESS_COPY.roles;
    return null;
  }

  private settings(): Settings | null {
    if (this.readiness()) return null;
    const identity = this.admin.patronLink();
    return {
      origin: identity.origin,
      discordClientId: identity.clientId,
      discordClientSecret: identity.clientSecret,
      patreonClientId: this.env.get("PATREON_CLIENT_ID")!,
      patreonClientSecret: this.env.get("PATREON_CLIENT_SECRET")!,
      // Readiness checked both: the import is configured, so its campaign is set and its token is valid.
      campaignId: patreonCampaign(this.env)!,
      creatorToken: this.env.get("PATREON_CREATOR_ACCESS_TOKEN")!,
    };
  }

  /** /patreon link and the panel button: a one-time link for this Discord account, or why not. */
  async request(request: PatronLinkRequest): Promise<PatronLinkReply> {
    try {
      if (!this.enabled()) return { content: PATRON_COPY.off };
      const guildId = this.env.get("ADMIN_GUILD_ID");
      if (!guildId || request.guildId !== guildId || request.bot) return { content: PATRON_COPY.wrongServer };
      const settings = this.settings();
      if (!settings) return { content: PATRON_COPY.notSetUp };
      if (await this.store.linked(settings.campaignId, request.userId))
        return { content: `${PATRON_COPY.already}\n${PATRON_COPY.alreadyFinePrint}` };
      const issued = this.state.issueTicket(request.userId);
      if ("refused" in issued)
        return { content: issued.refused === "limited" ? PATRON_COPY.limited : PATRON_COPY.failed };
      return issuedReply(`${settings.origin}${PATRON_LINK_PATHS.start}?${new URLSearchParams({ t: issued.ticket })}`);
    } catch {
      this.logger.warn(PATRON_LINK_FAILED);
      return { content: PATRON_COPY.failed };
    }
  }

  /** The dashboard's admins (an owner ID or a listed admin role). Discord permissions alone never count. */
  private isAdmin(request: PatronLinkRequest) {
    return staffRoleFor(request.userId, request.roles, this.admin.staffPolicy()) === "admin";
  }

  /** /patreon panel: posts the Link Patreon button in this channel, or says what to fix first. */
  async panel(request: PatronLinkRequest): Promise<string> {
    try {
      const guildId = this.env.get("ADMIN_GUILD_ID");
      if (!guildId || request.guildId !== guildId) return PATRON_COPY.wrongServer;
      if (!this.isAdmin(request)) return STAFF_COPY.adminsOnly;
      if (!this.enabled()) return PATRON_COPY.off;
      const problem = this.readiness();
      if (problem) return problem;
      const channel = request.channelId ? await this.panelChannel(guildId, request.channelId) : null;
      if (!channel) return STAFF_COPY.channel;
      try {
        // Gramps sends once and never retries. The REST client repeats a request that timed out or hit a 5xx; the
        // nonce lets Discord drop that duplicate instead of posting a second panel.
        await channel.send({
          ...panelMessage(),
          nonce: nonce(`patreon-panel:${guildId}:${channel.id}:${Date.now()}`),
          enforceNonce: true,
        });
      } catch (error) {
        return refused(error) ? STAFF_COPY.refused : STAFF_COPY.unknown;
      }
      return STAFF_COPY.posted;
    } catch {
      this.logger.warn(PATRON_LINK_FAILED);
      return PATRON_COPY.failed;
    }
  }

  /** A text or announcement channel in this guild where Gramps can view and post. */
  private async panelChannel(guildId: string, channelId: string): Promise<PanelChannel | null> {
    let channel: Awaited<ReturnType<Client["channels"]["fetch"]>>;
    try {
      channel = await this.discord.channels.fetch(channelId);
    } catch {
      return null;
    }
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) ||
      channel.guildId !== guildId
    )
      return null;
    const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe().catch(() => null));
    if (!me || !channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))
      return null;
    return channel;
  }

  private finish(outcome: PatronLinkOutcome): PatronLinkStep {
    this.logger.log(PATRON_LINK_FINISHED(outcome));
    return { outcome };
  }

  /** The start page: spends the ticket and sends the patron to Discord's sign-in. */
  start(ticket: unknown): PatronLinkStep {
    if (!this.enabled()) return this.finish("off");
    const settings = this.settings();
    if (!settings) return this.finish("unavailable");
    const discordId = this.state.takeTicket(ticket);
    if (!discordId) return this.finish("expired");
    const flow = this.state.startFlow(discordId);
    if (!flow) return this.finish("busy");
    return { location: this.oauth.discordAuthorizeUrl(settings, flow.state, true), flowId: flow.flowId };
  }

  /**
   * Discord's redirect. Nothing is called without this browser's sign-in and its state, and the account that signs
   * in must be the one that asked for the link, so a forwarded link stops here, before Patreon.
   */
  async discordCallback(flowId: unknown, query: Record<string, unknown>): Promise<PatronLinkStep> {
    const settings = this.enabled() ? this.settings() : null;
    if (!settings) {
      this.state.end(flowId);
      return this.finish(this.enabled() ? "unavailable" : "off");
    }
    const flow = this.state.claim(flowId, "discord", query.state);
    if (!flow) return this.finish("expired");
    const id = flowId as string;
    if (query.error !== undefined) {
      if (query.error === "access_denied") {
        this.state.end(id);
        return this.finish("declined");
      }
      // prompt=none can fail for someone who never signed in to Gramps. Ask once more, with the Authorize screen.
      const retry = flow.promptNone ? this.state.retryWithoutPrompt(id) : null;
      if (retry) return { location: this.oauth.discordAuthorizeUrl(settings, retry, false) };
      this.state.end(id);
      return this.finish("unavailable");
    }
    const code = validCode(query.code);
    if (!code) {
      this.state.end(id);
      return this.finish("expired");
    }
    let account: { id: string; bot: boolean };
    try {
      account = await this.oauth.discordUser(settings, code);
    } catch (error) {
      this.state.end(id);
      return this.finish(error instanceof PatronLinkCallError && error.kind === "rejected" ? "expired" : "unavailable");
    }
    if (account.bot || account.id !== flow.discordId) {
      this.state.end(id);
      return this.finish("wrong_account");
    }
    if (!this.state.startLeg(account.id)) {
      this.state.end(id);
      return this.finish("busy");
    }
    const state = this.state.advance(id);
    if (!state) return this.finish("expired");
    return { location: this.oauth.patreonAuthorizeUrl(settings, state), flowId: id };
  }

  /**
   * Every request to Patreon's redirect, before any limit can turn it away: a code that arrives without the sign-in
   * it belongs to is refused for good, so whoever lured a patron there cannot use it later with their own sign-in.
   * Calls nobody and never throws.
   */
  screenPatreonCallback(flowId: unknown, query: Record<string, unknown>) {
    try {
      const code = validCode(query.code);
      if (code && !this.state.holds(flowId, "patreon", query.state)) this.state.refuseCode(code);
    } catch {
      this.logger.warn(PATRON_LINK_FAILED);
    }
  }

  /**
   * Patreon's redirect. A code that arrives without its sign-in is refused for good and, within a budget, spent at
   * Patreon too. The flow ends before Patreon is called, so a replayed callback finds nothing.
   */
  async patreonCallback(flowId: unknown, query: Record<string, unknown>): Promise<PatronLinkStep> {
    const settings = this.enabled() ? this.settings() : null;
    if (!settings) {
      this.state.end(flowId);
      return this.finish(this.enabled() ? "unavailable" : "off");
    }
    const code = validCode(query.code);
    const flow = this.state.claim(flowId, "patreon", query.state);
    if (!flow) {
      if (code) {
        this.state.refuseCode(code);
        if (this.state.burnAllowed()) await this.oauth.burnPatreonCode(settings, code);
      }
      return this.finish("expired");
    }
    this.state.end(flowId);
    if (query.error !== undefined) return this.finish(query.error === "access_denied" ? "declined" : "unavailable");
    if (!code) return this.finish("expired");
    // A code seen before without its sign-in (a lured patron's) never works, whoever brings it back.
    const check = this.state.codeCheck(code);
    if (check !== "ok") return this.finish(check === "busy" ? "busy" : "expired");
    let identity: { userId: string; memberships: string[] };
    try {
      identity = await this.oauth.patreonIdentity(settings, code);
    } catch (error) {
      return this.finish(error instanceof PatronLinkCallError && error.kind === "rejected" ? "expired" : "unavailable");
    }
    if (!identity.memberships.length) return this.finish("not_member");
    if (identity.memberships.length > 1) return this.finish("unavailable");
    const [patreonMemberId] = identity.memberships;
    // The creator's own view of this member, so the record and the result page are current. Patreon only lists the
    // creator's campaign for the identity scope, so a failed read still links; a member Patreon does not have, or one
    // of another campaign or patron, links nothing.
    let found: PatreonMemberResult | null | undefined;
    try {
      found = await this.patreon.member(patreonMemberId, settings.creatorToken);
    } catch {
      found = undefined;
    }
    if (
      found === null ||
      (found !== undefined &&
        ((found.campaignId !== null && found.campaignId !== settings.campaignId) ||
          (found.userId !== null && found.userId !== identity.userId)))
    )
      return this.finish("not_member");
    // Only a member Patreon names as this campaign's and this patron's is imported.
    if (found?.campaignId && found.userId) {
      const imported = await this.supporters.importApiMember(settings.campaignId, found.snapshot, new Date());
      // As after a sync: a changed record can change who holds the Supporter role.
      if (
        imported.discordId &&
        (imported.created || imported.updated || imported.payments || imported.revoked || imported.discordLinked)
      )
        this.notifyRoles(imported.discordId);
    }
    const result = await this.store.link({
      campaignId: settings.campaignId,
      patreonMemberId,
      discordId: flow.discordId,
      now: new Date(),
    });
    if (result.outcome !== "conflict") {
      this.notifyRoles(flow.discordId);
      // Fire-and-forget, and it never rejects. A founder promise still waits for the first payment's refund window.
      void this.match.member(result.memberId, "patron");
    }
    return this.finish(result.outcome);
  }

  /** The result page for an outcome; anything unknown shows the "didn't answer" page. */
  page(outcome: unknown) {
    return resultPage(isPatronLinkOutcome(outcome) ? outcome : "unavailable", this.env.get("ADMIN_GUILD_ID"));
  }

  /** Fire-and-forget: a role problem never fails the link. */
  private notifyRoles(discordId: string) {
    try {
      this.roles.supporterChanged(discordId);
    } catch {
      /* The role service logs its own problems. */
    }
  }
}
