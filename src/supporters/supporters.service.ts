import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import { EnvService } from "../env/env.service";
import type { Staff } from "../admin/admin.types";
import { SupportersStore } from "./supporters.store";
import {
  founderSchema,
  linkSchema,
  manualMemberSchema,
  parsePatreon,
  paymentSchema,
  policyDays,
  reviewSchema,
  type FounderPolicy,
  type SupporterMutation,
} from "./supporters.types";

@Injectable()
export class SupportersService {
  constructor(
    private readonly store: SupportersStore,
    private readonly env: EnvService,
  ) {}
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
      secret !== this.env.get("ADMIN_SESSION_SECRET"),
    );
  }
  policy(): FounderPolicy {
    const start = this.env.get("PATREON_FOUNDER_START_AT"),
      end = this.env.get("PATREON_FOUNDER_END_AT");
    const valid = Boolean(
      start &&
      end &&
      Number.isFinite(Date.parse(start)) &&
      Date.parse(end) - Date.parse(start) === policyDays * 86_400_000,
    );
    return {
      amountCents: 500,
      currency: "USD",
      startsAt: valid ? new Date(start!).toISOString() : null,
      endsAt: valid ? new Date(end!).toISOString() : null,
      configured: valid,
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
    return { ok: true, ...(await this.store.ingest(observation)) };
  }
  async list(staff: Staff, search: unknown = "") {
    this.admin(staff);
    const parsedSearch = z.string().trim().max(100).safeParse(search);
    if (!parsedSearch.success) throw new BadRequestException("Use a search of at most 100 characters.");
    const configured = this.configured(),
      founderPolicy = this.policy();
    return {
      enabled: this.env.get("PATREON_ENABLED"),
      configured,
      webhookConfigured: this.webhookConfigured(),
      founderPolicy,
      supporters: configured
        ? await this.store.list(this.env.get("PATREON_CAMPAIGN_ID")!, founderPolicy, undefined, parsedSearch.data)
        : [],
      search: parsedSearch.data,
      limit: 100,
      note: "Private Patreon records. Membership changes need review; a tier or active membership is not proof of a completed payment. Founder records are permanent promises for future standard whitelist access. No game or Discord access is changed here.",
    };
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
    if (!this.configured()) throw new ServiceUnavailableException("Patreon integration is not configured.");
    if (!z.uuid().safeParse(memberId).success) throw new BadRequestException("Invalid supporter record.");
    const schema = { link: linkSchema, payment: paymentSchema, founder: founderSchema, review: reviewSchema }[kind];
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Check the required confirmation and review fields.");
    const input = { ...parsed.data, kind } as SupporterMutation;
    if (input.kind === "payment" && input.paidAt.getTime() > Date.now() + 300_000)
      throw new BadRequestException("A completed payment cannot be in the future.");
    const policy = this.policy();
    if (kind === "founder" && !policy.configured)
      throw new ServiceUnavailableException(
        "Set the 15-day founder window when the Patreon page launches before recording founder promises.",
      );
    try {
      return await this.store.mutate(memberId, input, staff, this.env.get("PATREON_CAMPAIGN_ID")!, policy);
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
