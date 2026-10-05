import { Injectable } from "@nestjs/common";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A ticket from Discord works once, for this long. */
export const PATRON_LINK_TICKET_MS = 10 * 60_000;
/** Each sign-in leg (Discord, then Patreon) must come back within this long. */
export const PATRON_LINK_STAGE_MS = 10 * 60_000;
/** The whole sign-in must finish within this long. */
export const PATRON_LINK_FLOW_MS = 20 * 60_000;
/** Tickets per Discord account, and Patreon legs per verified account, are counted over this window. */
export const PATRON_LINK_LIMIT_WINDOW_MS = 10 * 60_000;
export const PATRON_LINK_TICKETS_PER_USER = 5;
export const PATRON_LINK_LEGS_PER_ACCOUNT = 5;
/** Patreon codes that arrive without their sign-in are spent at Patreon, at most this many a minute. */
export const PATRON_LINK_BURNS_PER_MINUTE = 30;
/**
 * A Patreon code that arrived without its sign-in is refused for this long, whether or not it could be spent at
 * Patreon. Patreon does not say how long a code lives. OAuth 2.0 (RFC 6749) recommends 10 minutes at most, so an hour
 * leaves a wide margin.
 */
export const PATRON_LINK_REFUSED_CODE_MS = 60 * 60_000;
/** Refused Patreon codes remembered at once. Past it, the oldest is dropped and no code is used until it expires. */
export const PATRON_LINK_MAX_REFUSED_CODES = 50_000;
/** Every map below holds at most this many entries; past it, new sign-ins are told to wait. */
export const PATRON_LINK_MAX_ENTRIES = 5000;
/** Tickets, flow IDs and states: 32 random bytes in base64url. */
export const PATRON_LINK_ID = /^[A-Za-z0-9_-]{43}$/;

export type PatronLinkStage = "discord" | "patreon";
export type PatronLinkFlow = {
  /** The Discord account that asked for the ticket. The Discord sign-in must be this account. */
  discordId: string;
  stage: PatronLinkStage;
  /** The OAuth state the current leg must return. A new one is drawn for every leg. */
  state: string;
  stageExpiresAt: number;
  flowExpiresAt: number;
  /** The Discord leg still asks Discord to skip its Authorize screen (one retry without it). */
  promptNone: boolean;
};

const randomId = () => randomBytes(32).toString("base64url");
/** A refused code is kept only as a 128-bit digest. A collision could only refuse a code, never accept one. */
const codeKey = (code: string) => createHash("sha256").update(code).digest().subarray(0, 16).toString("base64url");
function same(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Sliding-window counts per key, for at most PATRON_LINK_MAX_ENTRIES keys. */
class Counter {
  private readonly times = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Counts one more for `key`: "limited" past its limit, "busy" when no key can be added. Nothing is counted then. */
  take(key: string, now: number): "ok" | "limited" | "busy" {
    for (const [other, times] of this.times) {
      const recent = times.filter((time) => now - time < this.windowMs);
      if (recent.length) this.times.set(other, recent);
      else this.times.delete(other);
    }
    const recent = this.times.get(key);
    if (recent && recent.length >= this.limit) return "limited";
    if (!recent && this.times.size >= PATRON_LINK_MAX_ENTRIES) return "busy";
    this.times.set(key, [...(recent ?? []), now]);
    return "ok";
  }
}

/**
 * The sign-ins in progress, in memory only: a restart or a second replica expires them, and nothing here is ever
 * logged. Tickets are issued in Discord and spent once at the start page. A flow lives in the patron's browser as an
 * HttpOnly cookie, and its state must come back from each provider. Nothing in a URL names a Discord account.
 */
@Injectable()
export class PatronLinkState {
  private readonly tickets = new Map<string, { discordId: string; expiresAt: number }>();
  private readonly flows = new Map<string, PatronLinkFlow>();
  private readonly ticketsIssued = new Counter(PATRON_LINK_TICKETS_PER_USER, PATRON_LINK_LIMIT_WINDOW_MS);
  private readonly legsStarted = new Counter(PATRON_LINK_LEGS_PER_ACCOUNT, PATRON_LINK_LIMIT_WINDOW_MS);
  private burned: number[] = [];
  /** Digests of Patreon codes that arrived without their sign-in, each with when it may be forgotten, oldest first. */
  private readonly refusedCodes = new Map<string, number>();
  /** Until then no Patreon code is used, because a refused code was dropped before it expired. */
  private refusedCodesFullUntil = 0;

  private prune(now: number) {
    for (const [ticket, entry] of this.tickets) if (now >= entry.expiresAt) this.tickets.delete(ticket);
    for (const [flowId, flow] of this.flows)
      if (now >= flow.stageExpiresAt || now >= flow.flowExpiresAt) this.flows.delete(flowId);
  }

  /** A one-time ticket for this Discord account, or why none was issued. */
  issueTicket(discordId: string, now = Date.now()): { ticket: string } | { refused: "limited" | "busy" } {
    this.prune(now);
    if (this.tickets.size >= PATRON_LINK_MAX_ENTRIES) return { refused: "busy" };
    const counted = this.ticketsIssued.take(discordId, now);
    if (counted !== "ok") return { refused: counted };
    const ticket = randomId();
    this.tickets.set(ticket, { discordId, expiresAt: now + PATRON_LINK_TICKET_MS });
    return { ticket };
  }

  /** Spends a ticket: the Discord account it was issued to, or null. A ticket never works twice. */
  takeTicket(ticket: unknown, now = Date.now()) {
    if (typeof ticket !== "string" || !PATRON_LINK_ID.test(ticket)) return null;
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return entry && now < entry.expiresAt ? entry.discordId : null;
  }

  /** Starts a sign-in at the Discord leg, or null when too many are in progress. */
  startFlow(discordId: string, now = Date.now()) {
    this.prune(now);
    if (this.flows.size >= PATRON_LINK_MAX_ENTRIES) return null;
    const flowId = randomId();
    const flow: PatronLinkFlow = {
      discordId,
      stage: "discord",
      state: randomId(),
      stageExpiresAt: now + PATRON_LINK_STAGE_MS,
      flowExpiresAt: now + PATRON_LINK_FLOW_MS,
      promptNone: true,
    };
    this.flows.set(flowId, flow);
    return { flowId, state: flow.state };
  }

  /**
   * The flow behind this cookie, when it is at `stage`, in time, and `state` is the one this leg was given (compared
   * in constant time). Anything else ends the flow and gives null.
   */
  claim(flowId: unknown, stage: PatronLinkStage, state: unknown, now = Date.now()): PatronLinkFlow | null {
    if (typeof flowId !== "string" || !PATRON_LINK_ID.test(flowId)) return null;
    const flow = this.flows.get(flowId);
    if (!flow) return null;
    if (!this.matches(flow, stage, state, now)) {
      this.flows.delete(flowId);
      return null;
    }
    return { ...flow };
  }

  /** Whether `claim` would succeed, without ending or changing any flow. */
  holds(flowId: unknown, stage: PatronLinkStage, state: unknown, now = Date.now()) {
    if (typeof flowId !== "string" || !PATRON_LINK_ID.test(flowId)) return false;
    const flow = this.flows.get(flowId);
    return Boolean(flow && this.matches(flow, stage, state, now));
  }

  private matches(flow: PatronLinkFlow, stage: PatronLinkStage, state: unknown, now: number) {
    return (
      flow.stage === stage &&
      now < flow.stageExpiresAt &&
      now < flow.flowExpiresAt &&
      typeof state === "string" &&
      PATRON_LINK_ID.test(state) &&
      same(state, flow.state)
    );
  }

  /** Asks Discord again, this time with its Authorize screen. Returns the new state. */
  retryWithoutPrompt(flowId: string) {
    const flow = this.flows.get(flowId);
    if (!flow) return null;
    flow.promptNone = false;
    flow.state = randomId();
    return flow.state;
  }

  /** Moves a flow on to the Patreon leg, with a new state and a fresh stage window. Returns the new state. */
  advance(flowId: string, now = Date.now()) {
    const flow = this.flows.get(flowId);
    if (!flow) return null;
    flow.stage = "patreon";
    flow.state = randomId();
    flow.stageExpiresAt = Math.min(now + PATRON_LINK_STAGE_MS, flow.flowExpiresAt);
    return flow.state;
  }

  end(flowId: unknown) {
    if (typeof flowId === "string") this.flows.delete(flowId);
  }

  /** Counts a Patreon leg for this verified Discord account; false past the limit or the cap. */
  startLeg(discordId: string, now = Date.now()) {
    return this.legsStarted.take(discordId, now) === "ok";
  }

  /** Whether one more unmatched Patreon code may be spent this minute. */
  burnAllowed(now = Date.now()) {
    this.burned = this.burned.filter((time) => now - time < 60_000);
    if (this.burned.length >= PATRON_LINK_BURNS_PER_MINUTE) return false;
    this.burned.push(now);
    return true;
  }

  /**
   * Remembers a Patreon code that arrived without its sign-in, so no later callback can use it, even one with a valid
   * cookie and state: Patreon does not tie a code to the state it was asked with. Unlike spending it at Patreon, this
   * has no budget anyone can use up. When the list is full the oldest code is dropped, and no code is used until that
   * one would have expired.
   */
  refuseCode(code: string, now = Date.now()) {
    this.forgetRefusedCodes(now);
    const key = codeKey(code);
    // Moved to the end with a fresh expiry, so the list stays in expiry order.
    this.refusedCodes.delete(key);
    if (this.refusedCodes.size >= PATRON_LINK_MAX_REFUSED_CODES) {
      const [oldest, expiresAt] = this.refusedCodes.entries().next().value!;
      this.refusedCodes.delete(oldest);
      this.refusedCodesFullUntil = Math.max(this.refusedCodesFullUntil, expiresAt);
    }
    this.refusedCodes.set(key, now + PATRON_LINK_REFUSED_CODE_MS);
  }

  /**
   * Whether a Patreon code may be exchanged: `refused` when it arrived before without its sign-in, `busy` while a
   * dropped refused code could still be valid.
   */
  codeCheck(code: string, now = Date.now()): "ok" | "refused" | "busy" {
    this.forgetRefusedCodes(now);
    if (this.refusedCodes.has(codeKey(code))) return "refused";
    return now < this.refusedCodesFullUntil ? "busy" : "ok";
  }

  /** Forgets refused codes past their time. They were added in expiry order, so only the oldest are checked. */
  private forgetRefusedCodes(now: number) {
    for (const [key, expiresAt] of this.refusedCodes) {
      if (now < expiresAt) break;
      this.refusedCodes.delete(key);
    }
  }
}
