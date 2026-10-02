import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Staff } from "../admin/admin.types";
import { EnvService } from "../env/env.service";
import { DiscordRolesDiscord, type RoleMember } from "./discord-roles.discord";
import { DiscordRolesStore } from "./discord-roles.store";
import {
  ADMIN_COOLDOWN_MS,
  BACKOFF_MS,
  BASIS_TYPES,
  classifyDiscordError,
  decide,
  EVENT_DEBOUNCE_MS,
  FOLLOW_UP_MS,
  MAX_PLAN_ENTRIES,
  MAX_WRITES_PER_PASS,
  READY_POLL_MS,
  reconcileSchema,
  ROLE_KINDS,
  ROLE_REASONS,
  SAFETY_PASS_MS,
  WRITE_SPACING_MS,
  type AttentionItem,
  type DiscordFailure,
  type DiscordRoleKind,
  type DiscordRoleTrigger,
  type PassSummary,
  type RoleCheckView,
  type RolesCheck,
} from "./discord-roles.types";

const FAILURE_MESSAGES: Record<Exclude<DiscordFailure, "transient">, string> = {
  permission: "Discord refused: the bot cannot manage this role. Check Manage Roles and the role order.",
  "unknown-role": "Discord refused: the role no longer exists. Check the configured role ID.",
  left: "The member left the server before the change.",
  rejected: "Discord refused this change.",
};
const RETRY_AFTER_ERROR_MS = 300_000;
const MAX_QUEUED_USERS = 5_000;
const MAX_ATTENTION = 100;

class SetupProblem extends Error {}

/**
 * Keeps the UNC member, Founder and Supporter roles in step with approved applications, founder records and
 * current support. One pass runs at a time in this process (a single Gramps instance is assumed; Discord's role
 * add and remove calls are idempotent anyway). Every change is written to the role ledger before Discord is
 * contacted, and only roles Gramps itself added during the current membership are ever removed.
 */
@Injectable()
export class DiscordRolesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DiscordRolesService.name);
  private running = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt = 0;
  private safetyTimer?: ReturnType<typeof setTimeout>;
  private fullPending: DiscordRoleTrigger | null = null;
  private fullNotBefore = 0;
  private readonly pendingUsers = new Map<string, DiscordRoleTrigger>();
  /** Users left over by the write budget or waiting out a backoff, with the earliest time to retry. */
  private readonly deferredUsers = new Map<string, { trigger: DiscordRoleTrigger; at: number }>();
  private readonly backoff = new Map<string, { failures: number; until: number }>();
  /**
   * Attention items kept across passes, one per person and role ("" for the person), so a later check of
   * someone else never hides them. An item is replaced or cleared when that person and role are checked.
   */
  private readonly attentionItems = new Map<string, AttentionItem>();
  private lastPass: PassSummary | null = null;
  private lastFullPass: PassSummary | null = null;
  private lastAdminAt = 0;
  private readonly adminResults = new Map<string, { actorId: string; fingerprint: string; summary: PassSummary }>();

  constructor(
    private readonly store: DiscordRolesStore,
    private readonly discord: DiscordRolesDiscord,
    private readonly env: EnvService,
  ) {}

  private options() {
    const ids = (value: string | undefined) =>
      (value ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    return {
      enabled: this.env.get("DISCORD_ROLES_ENABLED") === true,
      guildId: this.env.get("ADMIN_GUILD_ID"),
      roleIds: {
        member: this.env.get("DISCORD_MEMBER_ROLE_ID"),
        founder: this.env.get("DISCORD_FOUNDER_ROLE_ID"),
        supporter: this.env.get("DISCORD_SUPPORTER_ROLE_ID"),
      } as Record<DiscordRoleKind, string | undefined>,
      // Patreon records count for the Supporter role only for the configured campaign, as on the supporter dashboard.
      patreonCampaignId: (this.env.get("PATREON_ENABLED") && this.env.get("PATREON_CAMPAIGN_ID")) || null,
      staffRoleIds: [
        ...ids(this.env.get("ADMIN_ADMIN_ROLE_IDS")),
        ...ids(this.env.get("ADMIN_MODERATOR_ROLE_IDS")),
        ...ids(this.env.get("ADMIN_VIEWER_ROLE_IDS")),
      ],
    };
  }

  // ----- Triggers -----

  onApplicationBootstrap() {
    if (!this.options().enabled) return;
    // Wait for the gateway with an unref'd poll, then reconcile everyone once.
    this.fullPending = "startup";
    this.wake(0);
    this.scheduleSafetyPass();
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
  }

  /** An application was approved, rechecked or revoked. Fire-and-forget; never throws. */
  applicationChanged(discordUserId: string | null | undefined) {
    this.enqueue(discordUserId, "event");
  }

  /**
   * A founder was recorded, a supporter's Discord account changed, or support started, changed or ended.
   * Fire-and-forget; never throws. Time-based expiry needs no event: the six-hour safety pass re-reads it.
   */
  supporterChanged(discordUserId: string | null | undefined) {
    this.enqueue(discordUserId, "event");
  }

  /** Someone joined a guild. Only the configured community server matters. */
  memberJoined(guildId: string, discordUserId: string) {
    if (guildId === this.options().guildId) this.enqueue(discordUserId, "member-join");
  }

  private enqueue(discordUserId: string | null | undefined, trigger: DiscordRoleTrigger) {
    try {
      if (this.stopped || !this.options().enabled || !discordUserId || !/^\d{17,20}$/.test(discordUserId)) return;
      // The six-hour safety pass catches anyone dropped by this bound.
      if (this.pendingUsers.size >= MAX_QUEUED_USERS) return;
      if (this.pendingUsers.get(discordUserId) !== "member-join") this.pendingUsers.set(discordUserId, trigger);
      this.wake(EVENT_DEBOUNCE_MS);
    } catch {
      this.logger.warn("Could not queue a Discord role check. The six-hour safety pass will cover it.");
    }
  }

  private wake(delay: number) {
    if (this.stopped) return;
    const at = Date.now() + delay;
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
    this.timer.unref?.();
  }

  /** Arms the timer for the earliest person left over by the write budget or waiting out a backoff. */
  private wakeForDeferred() {
    const next = Math.min(...[...this.deferredUsers.values()].map((entry) => entry.at));
    if (Number.isFinite(next)) this.wake(Math.max(0, next - Date.now()));
  }

  private scheduleSafetyPass() {
    if (this.stopped) return;
    this.safetyTimer = setTimeout(() => {
      this.fullPending ??= "schedule";
      this.wake(0);
      this.scheduleSafetyPass();
    }, SAFETY_PASS_MS);
    this.safetyTimer.unref?.();
  }

  /** Runs whatever is due. Tests call it directly; it only re-arms its own timer. */
  async tick() {
    if (this.stopped || !this.options().enabled) return;
    if (this.running || !this.discord.ready()) return this.wake(READY_POLL_MS);
    const now = Date.now();
    for (const [userId, entry] of this.deferredUsers)
      if (entry.at <= now) {
        this.deferredUsers.delete(userId);
        if (!this.pendingUsers.has(userId)) this.pendingUsers.set(userId, entry.trigger);
      }
    try {
      if (this.fullPending && now >= this.fullNotBefore) {
        const trigger = this.fullPending;
        this.fullPending = null;
        // A full pass covers everyone with a reason to hold or lose a role.
        this.pendingUsers.clear();
        const summary = await this.pass(trigger, null);
        if (summary.error && !summary.error.startsWith("Setup:")) {
          this.fullPending ??= trigger;
          this.fullNotBefore = Date.now() + RETRY_AFTER_ERROR_MS;
        }
      } else if (this.pendingUsers.size) {
        const users = new Map(this.pendingUsers);
        this.pendingUsers.clear();
        const summary = await this.pass("event", users);
        if (summary.error && !summary.error.startsWith("Setup:"))
          for (const [userId, trigger] of users)
            this.deferredUsers.set(userId, { trigger, at: Date.now() + RETRY_AFTER_ERROR_MS });
      }
    } finally {
      if (this.pendingUsers.size) this.wake(EVENT_DEBOUNCE_MS);
      if (this.fullPending) this.wake(Math.max(0, this.fullNotBefore - Date.now()));
      this.wakeForDeferred();
    }
  }

  // ----- The pass -----

  /** Waits between Discord writes. Replaced in tests. */
  protected sleep(ms: number) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms).unref?.();
    });
  }

  private defer(userId: string, trigger: DiscordRoleTrigger, at: number) {
    const existing = this.deferredUsers.get(userId);
    if (!existing || existing.at > at) this.deferredUsers.set(userId, { trigger, at });
  }

  /** Clears kept attention items for a person: the person-level slot ("") and/or role slots. */
  private forgetAttention(userId: string, slots: readonly (DiscordRoleKind | "")[] = ["", ...ROLE_KINDS]) {
    for (const slot of slots) this.attentionItems.delete(`${userId}:${slot}`);
  }

  private retryLater(userId: string, trigger: DiscordRoleTrigger) {
    const failures = (this.backoff.get(userId)?.failures ?? 0) + 1;
    const until = Date.now() + BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1];
    if (this.backoff.size >= MAX_QUEUED_USERS) this.backoff.clear();
    this.backoff.set(userId, { failures, until });
    this.defer(userId, trigger, until);
  }

  private async pass(
    trigger: DiscordRoleTrigger,
    users: Map<string, DiscordRoleTrigger> | null,
    requestedBy: string | null = null,
    dryRun = false,
    reason?: string,
  ): Promise<PassSummary> {
    const options = this.options();
    const summary: PassSummary = {
      trigger,
      requestedBy,
      ...(reason ? { reason } : {}),
      dryRun,
      startedAt: new Date().toISOString(),
      finishedAt: "",
      users: 0,
      added: 0,
      removed: 0,
      noted: 0,
      confirmed: 0,
      failed: 0,
      blocked: 0,
      deferred: 0,
      error: null,
      attention: [],
      ...(dryRun ? { plan: [] } : {}),
    };
    const plan = summary.plan;
    const attention = (item: AttentionItem) => {
      const stamped = { ...item, at: new Date().toISOString() };
      if (summary.attention.length < MAX_ATTENTION) summary.attention.push(stamped);
      if (dryRun || !item.discordUserId) return;
      const slot = `${item.discordUserId}:${item.roleKind ?? ""}`;
      this.attentionItems.delete(slot);
      if (this.attentionItems.size < MAX_QUEUED_USERS) this.attentionItems.set(slot, stamped);
    };
    if (!dryRun) this.running = true;
    const blockedKinds = new Set<DiscordRoleKind>();
    try {
      if (!options.guildId) throw new SetupProblem("Set ADMIN_GUILD_ID to the community Discord server.");
      const guildId = options.guildId;
      const check = await this.discord.check(guildId, options.roleIds, options.staffRoleIds);
      for (const kind of ROLE_KINDS)
        if (options.roleIds[kind] && !check.roles[kind].assignable) {
          blockedKinds.add(kind);
          summary.blocked++;
        }
      const usable = ROLE_KINDS.filter((kind) => options.roleIds[kind] && check.roles[kind].assignable);
      if (!usable.length)
        throw new SetupProblem("No role can be assigned. Fix the role setup on the Discord roles page.");
      const list = users ? [...users.keys()] : undefined;
      // The Supporter role is read only while it is configured and passes its checks.
      const supporterRole = usable.includes("supporter") ? options.roleIds.supporter! : null;
      const [desired, revoked, supporting, held] = await Promise.all([
        this.store.desired(list),
        this.store.revokedBasis(list),
        supporterRole ? this.store.supporterDesired(list, options.patreonCampaignId) : new Map<string, string>(),
        supporterRole ? this.store.heldBasis(guildId, "supporter", supporterRole, list) : new Map<string, string>(),
      ]);
      const wanted: Record<DiscordRoleKind, Map<string, string>> = { ...desired, supporter: supporting };
      // The record that used to justify a role that has ended. A Supporter role Gramps holds for someone who no
      // longer supports has lapsed; its basis is the supporter record named when Gramps added it.
      const ended: Record<DiscordRoleKind, Map<string, string>> = {
        member: revoked,
        founder: new Map(),
        supporter: new Map([...held].filter(([userId]) => !supporting.has(userId))),
      };
      const candidates = [
        ...new Set([
          ...ROLE_KINDS.flatMap((kind) => [...wanted[kind].keys()]),
          ...ROLE_KINDS.flatMap((kind) => [...ended[kind].keys()]),
        ]),
      ];
      if (!dryRun) {
        // People this pass covers who no longer have a reason to hold or lose a role need no attention.
        const covered = new Set(candidates);
        for (const [slot, item] of this.attentionItems)
          if (!covered.has(item.discordUserId!) && (!users || users.has(item.discordUserId!)))
            this.attentionItems.delete(slot);
      }
      if (plan && list)
        for (const userId of list)
          if (!candidates.includes(userId))
            plan.push({ discordUserId: userId, roleKind: null, op: "none", why: "no-basis" });
      let writes = 0;
      for (const userId of candidates) {
        if (this.stopped || (plan && plan.length >= MAX_PLAN_ENTRIES)) break;
        const userTrigger = users?.get(userId) ?? trigger;
        const backoff = this.backoff.get(userId);
        if (!dryRun && backoff && backoff.until > Date.now()) {
          this.defer(userId, userTrigger, backoff.until);
          continue;
        }
        if (!dryRun && writes >= MAX_WRITES_PER_PASS) {
          this.defer(userId, userTrigger, Date.now() + FOLLOW_UP_MS);
          summary.deferred++;
          continue;
        }
        summary.users++;
        if (!dryRun) this.forgetAttention(userId, [""]);
        let member: RoleMember | null;
        try {
          member = await this.discord.member(guildId, userId);
        } catch (error) {
          summary.failed++;
          attention({ kind: "failed", discordUserId: userId });
          if (!dryRun && classifyDiscordError(error) === "transient") this.retryLater(userId, userTrigger);
          continue;
        }
        if (!member) {
          if (!dryRun) this.forgetAttention(userId);
          // Someone whose only reason is the Supporter role needs no attention: joining queues a check that adds it.
          if (wanted.member.has(userId) || wanted.founder.has(userId) || revoked.has(userId))
            attention({ kind: "not_in_server", discordUserId: userId });
          plan?.push({ discordUserId: userId, roleKind: null, op: "none", why: "not-in-server" });
          continue;
        }
        for (const kind of usable) {
          if (blockedKinds.has(kind)) continue;
          if (!dryRun) this.forgetAttention(userId, [kind]);
          const roleId = options.roleIds[kind]!;
          const desiredBasis = wanted[kind].get(userId) ?? null;
          const endedBasis = ended[kind].get(userId) ?? null;
          if (!desiredBasis && !endedBasis) continue;
          const decision = decide({
            kind,
            desiredBasis,
            endedBasis,
            hasRole: member.has(roleId),
            joinedAt: member.joinedAt,
            lastEffective: await this.store.lastEffective(guildId, userId, kind, roleId),
          });
          if (decision.why === "removed-in-discord")
            attention({ kind: "removed_in_discord", discordUserId: userId, roleKind: kind, basisId: desiredBasis! });
          if (plan) {
            if (decision.op !== "none" || ["removed-in-discord", "not-ours"].includes(decision.why))
              plan.push({ discordUserId: userId, roleKind: kind, op: decision.op, why: decision.why });
            continue;
          }
          if (decision.op === "none") continue;
          const base = {
            trigger: userTrigger,
            requestedBy,
            guildId,
            discordUserId: userId,
            roleKind: kind,
            roleId,
            basisType: BASIS_TYPES[kind],
          };
          if (decision.op === "confirm") {
            await this.store.confirm(decision.entryId, decision.why === "unknown-add-present" ? "add" : "remove");
            summary.confirmed++;
            this.backoff.delete(userId);
            continue;
          }
          if (decision.op === "note") {
            await this.store.note({ ...base, basisId: decision.basisId }, decision.why);
            summary.noted++;
            continue;
          }
          const reasons: { add: string; remove?: string } = ROLE_REASONS[kind];
          const reason = decision.op === "add" ? reasons.add : reasons.remove;
          // decide() never removes a Founder role; a role without a removal reason is never removed.
          if (!reason) continue;
          if (writes >= MAX_WRITES_PER_PASS) {
            this.defer(userId, userTrigger, Date.now() + FOLLOW_UP_MS);
            summary.deferred++;
            break;
          }
          if (writes > 0) await this.sleep(WRITE_SPACING_MS);
          writes++;
          // The ledger row is committed before Discord is contacted; a crash leaves it "started" (unknown).
          const actionId = await this.store.begin({ ...base, operation: decision.op, basisId: decision.basisId });
          let failure: DiscordFailure | null = null;
          try {
            if (decision.op === "add") await member.add(roleId, reason);
            else await member.remove(roleId, reason);
          } catch (error) {
            failure = classifyDiscordError(error);
          }
          if (!failure) {
            await this.store.finish(actionId, "applied", true, decision.op === "add" ? "Role added." : "Role removed.");
            summary[decision.op === "add" ? "added" : "removed"]++;
            this.backoff.delete(userId);
            continue;
          }
          summary.failed++;
          attention({ kind: "failed", discordUserId: userId, roleKind: kind, basisId: decision.basisId });
          if (failure === "transient") {
            await this.store.finish(
              actionId,
              "unknown",
              false,
              "Discord did not confirm the change. Gramps will check this member again later.",
            );
            this.retryLater(userId, userTrigger);
            break;
          }
          await this.store.finish(actionId, "failed", false, FAILURE_MESSAGES[failure]);
          if (failure === "permission" || failure === "unknown-role") {
            blockedKinds.add(kind);
            summary.blocked++;
          }
          if (failure === "left") break;
        }
      }
    } catch (error) {
      summary.error =
        error instanceof SetupProblem
          ? `Setup: ${error.message}`
          : "The role pass stopped early because Discord or the database was unavailable.";
      // Database and Discord error text can carry SQL parameters, member IDs or tokens: log fixed text only.
      if (!dryRun)
        this.logger.warn(
          `Discord role pass (${trigger}) did not finish: ${
            error instanceof SetupProblem ? error.message : "Discord or the database was unavailable."
          } Recorded changes are kept.`,
        );
    } finally {
      if (!dryRun) this.running = false;
      summary.finishedAt = new Date().toISOString();
    }
    if (!dryRun && blockedKinds.size && !summary.error)
      this.logger.warn(
        `Discord role pass (${trigger}) skipped the ${[...blockedKinds].join(" and ")} role: check the role setup on the Discord roles page.`,
      );
    if (!dryRun) {
      // An event check that found nothing to do (for example someone with no application joining) does not
      // replace the last meaningful result.
      const idle = trigger === "event" && !summary.users && !summary.deferred && !summary.blocked && !summary.error;
      if (!idle) this.lastPass = summary;
      if (!users) this.lastFullPass = summary;
    }
    return summary;
  }

  // ----- Staff endpoints -----

  private requireAdmin(staff: Staff) {
    if (staff.role !== "admin") throw new ForbiddenException("Only administrators can manage Discord roles.");
  }

  private unconfiguredRole(id: string | undefined, problem: string): RoleCheckView {
    return {
      id: id ?? null,
      name: null,
      exists: false,
      position: null,
      managed: false,
      privileged: false,
      staffRole: false,
      assignable: false,
      problem,
    };
  }

  async status(staff: Staff) {
    this.requireAdmin(staff);
    const options = this.options();
    const discordReady = this.discord.ready();
    let check: RolesCheck | null = null;
    let checkProblem = !options.guildId
      ? "Set ADMIN_GUILD_ID to the community Discord server."
      : !discordReady
        ? "Discord is not connected yet."
        : null;
    if (!checkProblem)
      try {
        check = await this.discord.check(options.guildId!, options.roleIds, options.staffRoleIds);
      } catch {
        checkProblem = "The Discord server could not be read. Check that the bot is in ADMIN_GUILD_ID.";
      }
    const roles = Object.fromEntries(
      ROLE_KINDS.map((kind) => [
        kind,
        check?.roles[kind] ?? this.unconfiguredRole(options.roleIds[kind], checkProblem!),
      ]),
    ) as Record<DiscordRoleKind, RoleCheckView>;
    const configuredKinds = ROLE_KINDS.filter((kind) => options.roleIds[kind]);
    const [summary, foundersWithoutDiscord, recent, supporterEligible] = await Promise.all([
      this.store.summary(),
      this.store.foundersWithoutDiscord(),
      this.store.recent(25),
      // People who support right now; counted only while the Supporter role is configured.
      options.roleIds.supporter
        ? this.store.supporterDesired(undefined, options.patreonCampaignId).then((desired) => desired.size)
        : null,
    ]);
    const next = Math.min(...[...this.deferredUsers.values()].map((entry) => entry.at));
    return {
      enabled: options.enabled,
      configured: {
        guild: Boolean(options.guildId),
        memberRole: Boolean(options.roleIds.member),
        founderRole: Boolean(options.roleIds.founder),
        supporterRole: Boolean(options.roleIds.supporter),
      },
      discordReady,
      bot: { manageRoles: check?.manageRoles ?? null, highestRolePosition: check?.highestRolePosition ?? null },
      roles,
      // Ready to switch on: every configured role passes its checks.
      ready: Boolean(check) && configuredKinds.length > 0 && configuredKinds.every((kind) => roles[kind].assignable),
      running: this.running,
      lastPass: this.lastPass,
      /** The last check of everyone (startup, the six-hour safety pass or an untargeted staff run). */
      lastFullPass: this.lastFullPass,
      queued: this.pendingUsers.size + this.deferredUsers.size,
      fullPassQueued: this.fullPending !== null,
      nextRetryAt: Number.isFinite(next) ? new Date(next).toISOString() : null,
      summary: { ...summary, supporterEligible },
      attention: [
        ...foundersWithoutDiscord.map(
          (founder): AttentionItem => ({
            kind: "founder_without_discord",
            supporterId: founder.supporterId,
            displayName: founder.displayName,
            provider: founder.provider,
            at: new Date(founder.awardedAt).toISOString(),
          }),
        ),
        ...[...this.attentionItems.values()].slice(0, MAX_ATTENTION),
      ],
      recent,
      note: "Gramps adds the UNC role for approved UNC member applications, the Founder role for founders with a linked Discord account and, when configured, the Supporter role for people who support right now (an active Patreon membership, a declined Patreon charge for up to 7 days, or a PayPal payment in the last 31 days). It removes only roles it added itself: the UNC role after that application is revoked, and the Supporter role after support lapses. Founder roles are never removed automatically. The Supporter role is a Discord role only.",
    };
  }

  async reconcile(staff: Staff, body: unknown) {
    this.requireAdmin(staff);
    const parsed = reconcileSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Send an action ID, a reason and an optional Discord user ID.");
    const input = parsed.data;
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const previous = this.adminResults.get(input.id);
    if (previous) {
      if (previous.actorId !== staff.id || previous.fingerprint !== fingerprint)
        throw new ConflictException("This action ID was already used for another role check.");
      return { ok: true, replayed: true, summary: previous.summary };
    }
    const options = this.options();
    if (!input.dryRun && !options.enabled)
      throw new ServiceUnavailableException("Discord roles are switched off (DISCORD_ROLES_ENABLED=false).");
    if (!this.discord.ready())
      throw new ServiceUnavailableException("Discord is not connected yet. Try again shortly.");
    if (this.running) throw new ConflictException("A role check is already running. Try again when it finishes.");
    if (Date.now() - this.lastAdminAt < ADMIN_COOLDOWN_MS)
      throw new HttpException("Wait 30 seconds between role checks.", 429);
    this.lastAdminAt = Date.now();
    const users = input.discordUserId ? new Map([[input.discordUserId, "admin" as const]]) : null;
    const summary = await this.pass("admin", users, staff.id, input.dryRun === true, input.reason);
    // People left over by the write budget or a backoff get their follow-up like any other pass.
    if (!input.dryRun) this.wakeForDeferred();
    if (this.adminResults.size >= 100) this.adminResults.clear();
    this.adminResults.set(input.id, { actorId: staff.id, fingerprint, summary });
    return { ok: true, replayed: false, summary };
  }
}
