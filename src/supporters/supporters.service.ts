import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import { AdminAuth } from "../admin/admin.auth";
import { AdminSettings } from "../admin/admin.settings";
import { DiscordRolesService } from "../discord-roles/discord-roles.service";
import { EnvService } from "../env/env.service";
import type { Staff } from "../admin/admin.types";
import { deploymentSecrets, PatreonSyncService } from "./patreon-sync.service";
import { patronLinkSetupProblem } from "./patron-link-readiness";
import { SupporterMatchService } from "./supporter-match.service";
import { SupportersStore } from "./supporters.store";
import { founderPolicy, patreonCampaign } from "./founder-policy";
import {
  AUTO_FOUNDER_HOLD_HOURS_DEFAULT,
  steamMatchHidden,
  supporterNextSteps,
  type NextStepContext,
} from "./supporter-match.rules";
import {
  founderSchema,
  linkSchema,
  manualMemberSchema,
  parsePatreon,
  paymentSchema,
  paypalSchema,
  providerFilter,
  reviewSchema,
  signedByPatreon,
  type FounderPolicy,
  type SupporterListItem,
  type SupporterMutation,
  type SupporterView,
} from "./supporters.types";

@Injectable()
export class SupportersService {
  constructor(
    private readonly store: SupportersStore,
    private readonly env: EnvService,
    private readonly roles: DiscordRolesService,
    private readonly patreonSync: PatreonSyncService,
    private readonly match: SupporterMatchService,
    private readonly auth: AdminAuth,
    private readonly settings: AdminSettings,
  ) {}
  /** Lets the role service re-check this member. Fire-and-forget: a role problem never fails the request. */
  private notifyRoles(discordId: string | null | undefined) {
    try {
      this.roles.supporterChanged(discordId);
    } catch {
      /* The role service logs its own problems. */
    }
  }
  private configured() {
    return patreonCampaign(this.env) !== null;
  }
  /** The signing secret must be separate from the creator token and every other deployment secret. */
  private webhookConfigured() {
    const secret = this.env.get("PATREON_WEBHOOK_SECRET");
    return Boolean(
      this.configured() &&
      typeof secret === "string" &&
      secret.length >= 16 &&
      ![this.env.get("PATREON_CREATOR_ACCESS_TOKEN"), ...deploymentSecrets(this.env)].includes(secret),
    );
  }
  /** The configured Patreon campaign, or null when Patreon is off. PayPal records never need it. */
  private campaign() {
    return patreonCampaign(this.env);
  }
  /** The provider-neutral founder window (see founderPolicy). */
  policy(): FounderPolicy {
    return founderPolicy(this.env);
  }
  /**
   * What the next-step text may promise: which automatic matching is on, whether the import runs, and whether a
   * patron can link their own Discord, which needs Link Patreon switched on and every setting it uses ready.
   */
  private automation(): NextStepContext {
    const importConfigured = this.patreonSync.configured();
    return {
      steamFill: this.env.get("SUPPORTER_AUTO_STEAM_FILL_ENABLED") === true,
      founderAuto: this.env.get("SUPPORTER_AUTO_FOUNDER_ENABLED") === true,
      importConfigured,
      holdHours: this.policy().automaticHoldHours ?? AUTO_FOUNDER_HOLD_HOURS_DEFAULT,
      patronLink:
        this.env.get("PATREON_LINK_ENABLED") === true &&
        patronLinkSetupProblem(this.env, this.settings, importConfigured) === null,
    };
  }
  /**
   * The game servers this administrator may open. Whitelist applications belong to a server, so a supporter record
   * leaves out the SteamID, application and server of an application on any other server. A failed check shows no
   * server's applications.
   */
  private async serverAccess(staff: Staff): Promise<(serverId: string) => boolean> {
    try {
      const allowed = new Set((await this.auth.serverList(staff)).servers.map((server) => server.id));
      return (serverId) => allowed.has(serverId);
    } catch {
      return () => false;
    }
  }
  /**
   * Adds the steps still needed, built from the full facts so every verdict and alert stays, then removes application
   * details from servers the viewer cannot open.
   */
  private present(supporter: SupporterView, context: NextStepContext): SupporterListItem {
    const nextSteps = supporterNextSteps(supporter, context);
    const { steam, sourceApplication } = supporter.match;
    return {
      ...supporter,
      match: {
        ...supporter.match,
        steam:
          steam && steamMatchHidden(steam, context)
            ? { ...steam, steamId: null, applicationId: null, serverId: null }
            : steam,
        sourceApplication:
          sourceApplication && context.serverVisible && !context.serverVisible(sourceApplication.serverId)
            ? null
            : sourceApplication,
      },
      nextSteps,
    };
  }
  private async context(staff: Staff): Promise<NextStepContext> {
    return { ...this.automation(), serverVisible: await this.serverAccess(staff) };
  }
  /** Adds the steps still needed to a record before it leaves the service. */
  private async withSteps<T extends { supporter?: SupporterView | null }>(staff: Staff, result: T) {
    const supporter = result.supporter;
    return (supporter ? { ...result, supporter: this.present(supporter, await this.context(staff)) } : result) as Omit<
      T,
      "supporter"
    > & { supporter?: SupporterListItem | null };
  }
  private admin(staff: Staff) {
    if (staff.role !== "admin") throw new ForbiddenException("Only administrators can access supporter records.");
  }
  async webhook(raw: unknown, signature: unknown, trigger: unknown) {
    if (!this.webhookConfigured()) throw new ServiceUnavailableException("Patreon webhook is not configured.");
    const observation = parsePatreon(
      raw,
      signature,
      trigger,
      this.env.get("PATREON_WEBHOOK_SECRET")!,
      this.env.get("PATREON_CAMPAIGN_ID")!,
    );
    const result = await this.store.ingest(observation);
    // A new observation can start, pause or end support, so the Supporter role is checked again.
    if (!result.duplicate) {
      this.notifyRoles(result.discordId);
      // Webhooks carry no Discord account, so this rarely changes anything. Fire-and-forget: it never delays or
      // changes the response to Patreon.
      void this.match.member(result.memberId, "webhook");
    }
    return { ok: true, duplicate: result.duplicate };
  }
  /** Whether a webhook request carries a valid Patreon signature. The body is not parsed or kept. */
  signedWebhook(raw: unknown, signature: unknown) {
    return this.webhookConfigured() && signedByPatreon(raw, signature, this.env.get("PATREON_WEBHOOK_SECRET")!);
  }
  async list(staff: Staff, search: unknown = "", provider: unknown = undefined) {
    this.admin(staff);
    const parsedSearch = z.string().trim().max(100).safeParse(search);
    if (!parsedSearch.success) throw new BadRequestException("Use a search of at most 100 characters.");
    const parsedProvider = providerFilter.safeParse(provider === "" ? undefined : provider);
    if (!parsedProvider.success) throw new BadRequestException("Filter by the patreon or paypal provider.");
    const configured = this.configured(),
      founderPolicy = this.policy(),
      context = await this.context(staff);
    return {
      enabled: this.env.get("PATREON_ENABLED"),
      configured,
      webhookConfigured: this.webhookConfigured(),
      founderPolicy,
      // The PayPal ledger needs no provider connection and stays available when Patreon is not configured.
      paypal: { available: true },
      supporters: (
        await this.store.list(this.campaign(), founderPolicy, undefined, parsedSearch.data, parsedProvider.data)
      ).map((supporter) => this.present(supporter, context)),
      search: parsedSearch.data,
      provider: parsedProvider.data ?? null,
      limit: 100,
      sync: this.patreonSync.status(),
      automation: this.match.status(),
      note: "Private supporter records for Patreon and PayPal. Membership changes need review; a tier or active membership is not proof of a completed payment. Founder records are permanent promises for future standard whitelist access. No game access is changed here. When Discord roles are switched on, founders with a linked Discord account receive the Founder role, and people who currently support receive the Supporter role if it is configured. The Supporter role is a Discord role only. With automatic matching switched on, Gramps copies a Patreon supporter's empty SteamID from their approved whitelist application and can record a founder promise itself under a stricter rule; each record's next steps say what is left for staff.",
    };
  }
  /** Staff-triggered Patreon import; concurrent requests join the running sync. */
  async syncNow(staff: Staff) {
    this.admin(staff);
    if (!this.patreonSync.configured())
      throw new ServiceUnavailableException(
        "Patreon sync is not configured. Set PATREON_ENABLED, PATREON_CAMPAIGN_ID and PATREON_CREATOR_ACCESS_TOKEN.",
      );
    return { ok: true, ...(await this.patreonSync.staffSync()) };
  }
  async register(staff: Staff, body: unknown) {
    this.admin(staff);
    if (!this.configured()) throw new ServiceUnavailableException("Patreon supporter records are not configured.");
    const parsed = manualMemberSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Check the Patreon membership ID, confirmation and reason.");
    try {
      return await this.withSteps(
        staff,
        await this.store.register(parsed.data, staff, this.env.get("PATREON_CAMPAIGN_ID")!, this.policy()),
      );
    } catch (error) {
      this.translateConflict(error);
    }
  }
  async mutate(staff: Staff, memberId: string, kind: SupporterMutation["kind"], body: unknown) {
    this.admin(staff);
    if (!z.uuid().safeParse(memberId).success) throw new BadRequestException("Invalid supporter record.");
    const schema = { link: linkSchema, payment: paymentSchema, founder: founderSchema, review: reviewSchema }[kind];
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Check the required confirmation and review fields.");
    const input = { ...parsed.data, kind } as SupporterMutation;
    if (input.kind === "payment" && input.paidAt.getTime() > Date.now() + 300_000)
      throw new BadRequestException("A completed payment cannot be in the future.");
    const policy = this.policy();
    if (kind === "founder" && !policy.configured)
      throw new ServiceUnavailableException("Set the 15-day founder window before recording founder promises.");
    try {
      // The store applies the Patreon configuration check to Patreon records only.
      const campaign = this.campaign();
      const result: Awaited<ReturnType<SupportersStore["mutate"]>> & {
        automatic?: { steamFilled: boolean; founderRecorded: boolean };
      } = await this.store.mutate(memberId, input, staff, campaign, policy);
      // A staff Discord link completes the match the way an approval does, but only the SteamID: a staff-entered
      // Discord account never leads straight to a permanent founder promise. The record is read again, so the
      // dashboard's next action carries the new version.
      if (!result.replayed && input.kind === "link") {
        const automatic = await this.match.member(memberId, "link", { founder: false });
        if (automatic?.steamFilled) {
          // The link is saved either way; if the read fails, the dashboard's next action asks for a refresh.
          result.supporter = (await this.store.get(memberId, campaign, policy).catch(() => null)) ?? result.supporter;
          result.automatic = { steamFilled: true, founderRecorded: false };
        }
      }
      // A founder award, a changed Discord link or a new receipt can change who should hold the Founder or
      // Supporter role.
      if (!result.replayed && (input.kind === "founder" || input.kind === "link" || input.kind === "payment"))
        this.notifyRoles(result.supporter?.discordId);
      return await this.withSteps(staff, result);
    } catch (error) {
      this.translateConflict(error);
    }
  }
  async paypal(staff: Staff, body: unknown) {
    this.admin(staff);
    const parsed = paypalSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        "Check the PayPal transaction ID, amount, currency, accounts, confirmations and reason.",
      );
    if (parsed.data.paidAt.getTime() > Date.now() + 300_000)
      throw new BadRequestException("A completed payment cannot be in the future.");
    try {
      const result = await this.store.recordPaypal(parsed.data, staff, this.campaign(), this.policy());
      if (!result.replayed) this.notifyRoles(result.supporter?.discordId);
      return await this.withSteps(staff, result);
    } catch (error) {
      this.translateConflict(error);
    }
  }
  private translateConflict(error: unknown): never {
    let cause: unknown = error;
    for (let depth = 0; depth < 3 && cause && typeof cause === "object"; depth++) {
      if ("code" in cause && cause.code === "23505")
        throw new ConflictException(
          "This account, payment reference, action or founder record already exists. Refresh before reviewing.",
        );
      cause = "cause" in cause ? cause.cause : null;
    }
    throw error;
  }
}
