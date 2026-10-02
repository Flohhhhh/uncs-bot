import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import { DiscordRolesService } from "../discord-roles/discord-roles.service";
import { EnvService } from "../env/env.service";
import type { Staff } from "../admin/admin.types";
import { PatreonSyncService } from "./patreon-sync.service";
import { SupportersStore } from "./supporters.store";
import {
  FOUNDER_MINIMUM,
  founderSchema,
  linkSchema,
  manualMemberSchema,
  parsePatreon,
  paymentSchema,
  paypalSchema,
  policyDays,
  providerFilter,
  reviewSchema,
  type FounderPolicy,
  type SupporterMutation,
} from "./supporters.types";

@Injectable()
export class SupportersService {
  constructor(
    private readonly store: SupportersStore,
    private readonly env: EnvService,
    private readonly roles: DiscordRolesService,
    private readonly patreonSync: PatreonSyncService,
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
    return Boolean(this.env.get("PATREON_ENABLED") && this.env.get("PATREON_CAMPAIGN_ID"));
  }
  private webhookConfigured() {
    const secret = this.env.get("PATREON_WEBHOOK_SECRET");
    return Boolean(
      this.configured() &&
      typeof secret === "string" &&
      secret.length >= 16 &&
      secret !== this.env.get("WARDOGS_RCON_PASSWORD") &&
      secret !== this.env.get("WARDOGS_FEED_TOKEN") &&
      !this.env.get("WARDOGS_SERVERS")?.some((server) => secret === server.password || secret === server.feedToken) &&
      secret !== this.env.get("ADMIN_SESSION_SECRET"),
    );
  }
  /** The configured Patreon campaign, or null when Patreon is off. PayPal records never need it. */
  private campaign() {
    return this.configured() ? this.env.get("PATREON_CAMPAIGN_ID")! : null;
  }
  /**
   * The provider-neutral founder window. A complete SUPPORTER_FOUNDER_* pair wins; otherwise a
   * complete PATREON_FOUNDER_* pair is used. A half-set pair, or two complete pairs naming different
   * instants, leaves the window unconfigured rather than guessing.
   */
  policy(): FounderPolicy {
    const unconfigured: FounderPolicy = {
      amountCents: FOUNDER_MINIMUM.amountCents,
      currency: FOUNDER_MINIMUM.currency,
      startsAt: null,
      endsAt: null,
      configured: false,
      source: null,
    };
    const pairs = [
      {
        source: "SUPPORTER_FOUNDER" as const,
        start: this.env.get("SUPPORTER_FOUNDER_START_AT"),
        end: this.env.get("SUPPORTER_FOUNDER_END_AT"),
      },
      {
        source: "PATREON_FOUNDER" as const,
        start: this.env.get("PATREON_FOUNDER_START_AT"),
        end: this.env.get("PATREON_FOUNDER_END_AT"),
      },
    ];
    if (pairs.some((pair) => Boolean(pair.start) !== Boolean(pair.end))) return unconfigured;
    const complete = pairs.flatMap(({ source, start, end }) =>
      start && end ? [{ source, start: Date.parse(start), end: Date.parse(end) }] : [],
    );
    if (complete.length === 2 && (complete[0].start !== complete[1].start || complete[0].end !== complete[1].end))
      return unconfigured;
    const chosen = complete[0];
    if (!chosen || !Number.isFinite(chosen.start) || chosen.end - chosen.start !== policyDays * 86_400_000)
      return unconfigured;
    return {
      ...unconfigured,
      startsAt: new Date(chosen.start).toISOString(),
      endsAt: new Date(chosen.end).toISOString(),
      configured: true,
      source: chosen.source,
    };
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
    if (!result.duplicate) this.notifyRoles(result.discordId);
    return { ok: true, duplicate: result.duplicate };
  }
  async list(staff: Staff, search: unknown = "", provider: unknown = undefined) {
    this.admin(staff);
    const parsedSearch = z.string().trim().max(100).safeParse(search);
    if (!parsedSearch.success) throw new BadRequestException("Use a search of at most 100 characters.");
    const parsedProvider = providerFilter.safeParse(provider === "" ? undefined : provider);
    if (!parsedProvider.success) throw new BadRequestException("Filter by the patreon or paypal provider.");
    const configured = this.configured(),
      founderPolicy = this.policy();
    return {
      enabled: this.env.get("PATREON_ENABLED"),
      configured,
      webhookConfigured: this.webhookConfigured(),
      founderPolicy,
      // The PayPal ledger needs no provider connection and stays available when Patreon is not configured.
      paypal: { available: true },
      supporters: await this.store.list(
        this.campaign(),
        founderPolicy,
        undefined,
        parsedSearch.data,
        parsedProvider.data,
      ),
      search: parsedSearch.data,
      provider: parsedProvider.data ?? null,
      limit: 100,
      sync: this.patreonSync.status(),
      note: "Private supporter records for Patreon and PayPal. Membership changes need review; a tier or active membership is not proof of a completed payment. Founder records are permanent promises for future standard whitelist access. No game access is changed here. When Discord roles are switched on, founders with a linked Discord account receive the Founder role, and people who currently support receive the Supporter role if it is configured. The Supporter role is a Discord role only.",
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
      return await this.store.register(parsed.data, staff, this.env.get("PATREON_CAMPAIGN_ID")!, this.policy());
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
      const result = await this.store.mutate(memberId, input, staff, this.campaign(), policy);
      // A founder award, a changed Discord link or a new receipt can change who should hold the Founder or
      // Supporter role.
      if (!result.replayed && (input.kind === "founder" || input.kind === "link" || input.kind === "payment"))
        this.notifyRoles(result.supporter?.discordId);
      return result;
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
      return result;
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
