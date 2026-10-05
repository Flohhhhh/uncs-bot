import {
  PATRON_LINK_BURNS_PER_MINUTE,
  PATRON_LINK_FLOW_MS,
  PATRON_LINK_ID,
  PATRON_LINK_LEGS_PER_ACCOUNT,
  PATRON_LINK_LIMIT_WINDOW_MS,
  PATRON_LINK_MAX_ENTRIES,
  PATRON_LINK_MAX_REFUSED_CODES,
  PATRON_LINK_REFUSED_CODE_MS,
  PATRON_LINK_STAGE_MS,
  PATRON_LINK_TICKET_MS,
  PATRON_LINK_TICKETS_PER_USER,
  PatronLinkState,
  type PatronLinkStage,
} from "./patron-link.state";

const patron = "500000000000000001";
const other = "500000000000000002";
const t0 = Date.parse("2026-10-05T12:00:00.000Z");
const ticketOf = (issued: ReturnType<PatronLinkState["issueTicket"]>) => {
  if (!("ticket" in issued)) throw new Error("No ticket was issued.");
  return issued.ticket;
};

describe("tickets", () => {
  it("are 32 random bytes in base64url, different every time", () => {
    const state = new PatronLinkState();
    const first = ticketOf(state.issueTicket(patron, t0));
    const second = ticketOf(state.issueTicket(patron, t0));
    expect(first).toMatch(PATRON_LINK_ID);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(first).not.toBe(second);
  });
  it("work once, for the account they were issued to", () => {
    const state = new PatronLinkState();
    const ticket = ticketOf(state.issueTicket(patron, t0));
    expect(state.takeTicket(ticket, t0)).toBe(patron);
    expect(state.takeTicket(ticket, t0)).toBeNull();
  });
  it("last 599,999 ms and expire at 600,000 ms, and an expired one is gone", () => {
    const state = new PatronLinkState();
    const fresh = ticketOf(state.issueTicket(patron, t0));
    expect(state.takeTicket(fresh, t0 + PATRON_LINK_TICKET_MS - 1)).toBe(patron);
    const stale = ticketOf(state.issueTicket(other, t0));
    expect(state.takeTicket(stale, t0 + PATRON_LINK_TICKET_MS)).toBeNull();
    expect(state.takeTicket(stale, t0)).toBeNull();
    expect(PATRON_LINK_TICKET_MS).toBe(600_000);
  });
  it.each([undefined, null, 42, ["a".repeat(43)], "", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`])(
    "refuse a malformed ticket (%p)",
    (ticket) => {
      expect(new PatronLinkState().takeTicket(ticket, t0)).toBeNull();
    },
  );
  it("are limited to 5 per account per 10 minutes, then open again", () => {
    const state = new PatronLinkState();
    for (let index = 0; index < PATRON_LINK_TICKETS_PER_USER; index++)
      expect(state.issueTicket(patron, t0 + index)).toHaveProperty("ticket");
    expect(state.issueTicket(patron, t0 + 10)).toEqual({ refused: "limited" });
    // Another account has its own count.
    expect(state.issueTicket(other, t0 + 10)).toHaveProperty("ticket");
    expect(state.issueTicket(patron, t0 + PATRON_LINK_LIMIT_WINDOW_MS - 1)).toEqual({ refused: "limited" });
    // The first one counted leaves the window.
    expect(state.issueTicket(patron, t0 + PATRON_LINK_LIMIT_WINDOW_MS)).toHaveProperty("ticket");
    expect(state.issueTicket(patron, t0 + PATRON_LINK_LIMIT_WINDOW_MS)).toEqual({ refused: "limited" });
  });
  it("stop at 5000 waiting, and make room as they expire", () => {
    const state = new PatronLinkState();
    for (let index = 0; index < PATRON_LINK_MAX_ENTRIES; index++)
      ticketOf(state.issueTicket(String(100000000000000000n + BigInt(index)), t0));
    expect(state.issueTicket(patron, t0)).toEqual({ refused: "busy" });
    expect(state.issueTicket(patron, t0 + PATRON_LINK_TICKET_MS)).toHaveProperty("ticket");
  });
});

type Flow = { flowId: string; state: string };

describe("sign-in flows", () => {
  it("start at the Discord leg, asking Discord to skip its Authorize screen", () => {
    const state = new PatronLinkState();
    const flow = state.startFlow(patron, t0)!;
    expect(flow.flowId).toMatch(PATRON_LINK_ID);
    expect(flow.state).toMatch(PATRON_LINK_ID);
    expect(flow.flowId).not.toBe(flow.state);
    expect(state.claim(flow.flowId, "discord", flow.state, t0)).toEqual({
      discordId: patron,
      stage: "discord",
      state: flow.state,
      stageExpiresAt: t0 + PATRON_LINK_STAGE_MS,
      flowExpiresAt: t0 + PATRON_LINK_FLOW_MS,
      promptNone: true,
    });
  });
  it.each<[string, (flow: Flow) => [PatronLinkStage, unknown]]>([
    ["a wrong stage", (flow) => ["patreon", flow.state]],
    ["a wrong state", () => ["discord", "b".repeat(43)]],
    ["no state", () => ["discord", undefined]],
    ["a repeated state", (flow) => ["discord", [flow.state, flow.state]]],
    ["a malformed state", (flow) => ["discord", `${flow.state.slice(1)}=`]],
  ])("refuse %s and end the flow", (_name, attempt) => {
    const state = new PatronLinkState();
    const flow = state.startFlow(patron, t0)!;
    const [stage, value] = attempt(flow);
    expect(state.claim(flow.flowId, stage, value, t0)).toBeNull();
    // The flow is over: even the right state no longer works.
    expect(state.claim(flow.flowId, "discord", flow.state, t0)).toBeNull();
  });
  it.each([undefined, null, "", "x".repeat(43), ["a".repeat(43)]])("refuse a missing or unknown cookie (%p)", (id) => {
    const state = new PatronLinkState();
    const flow = state.startFlow(patron, t0)!;
    expect(state.claim(id, "discord", flow.state, t0)).toBeNull();
    // Someone else's cookie value never ends this flow.
    expect(state.claim(flow.flowId, "discord", flow.state, t0)).not.toBeNull();
  });
  it("keep each leg to 599,999 ms", () => {
    const state = new PatronLinkState();
    const flow = state.startFlow(patron, t0)!;
    expect(state.claim(flow.flowId, "discord", flow.state, t0 + PATRON_LINK_STAGE_MS - 1)).not.toBeNull();
    expect(state.claim(flow.flowId, "discord", flow.state, t0 + PATRON_LINK_STAGE_MS)).toBeNull();
  });
  it("rotate the state for the retry without prompt", () => {
    const state = new PatronLinkState();
    const flow = state.startFlow(patron, t0)!;
    const retry = state.retryWithoutPrompt(flow.flowId)!;
    expect(retry).toMatch(PATRON_LINK_ID);
    expect(retry).not.toBe(flow.state);
    expect(state.claim(flow.flowId, "discord", retry, t0)).toMatchObject({ promptNone: false, stage: "discord" });
    // The state Discord was first given no longer works.
    const again = state.startFlow(patron, t0)!;
    state.retryWithoutPrompt(again.flowId);
    expect(state.claim(again.flowId, "discord", again.state, t0)).toBeNull();
  });
  it("rotate the state for the Patreon leg, whose window never passes the flow's 20 minutes", () => {
    const state = new PatronLinkState();
    const flow = state.startFlow(patron, t0)!;
    const at = t0 + PATRON_LINK_STAGE_MS - 1;
    const leg = state.advance(flow.flowId, at)!;
    expect(leg).not.toBe(flow.state);
    expect(state.claim(flow.flowId, "patreon", leg, at + PATRON_LINK_STAGE_MS - 1)).toMatchObject({
      stage: "patreon",
      stageExpiresAt: at + PATRON_LINK_STAGE_MS,
    });
    const late = state.startFlow(patron, t0)!;
    const lateLeg = state.advance(late.flowId, t0 + 15 * 60_000)!;
    expect(state.claim(late.flowId, "patreon", lateLeg, t0 + PATRON_LINK_FLOW_MS - 1)).toMatchObject({
      stageExpiresAt: t0 + PATRON_LINK_FLOW_MS,
    });
    const capped = state.startFlow(patron, t0)!;
    const cappedLeg = state.advance(capped.flowId, t0 + 15 * 60_000)!;
    expect(state.claim(capped.flowId, "patreon", cappedLeg, t0 + PATRON_LINK_FLOW_MS)).toBeNull();
    const early = state.startFlow(patron, t0)!;
    const next = state.advance(early.flowId, t0 + 1_000)!;
    expect(state.claim(early.flowId, "patreon", next, t0)).toMatchObject({
      stageExpiresAt: t0 + 1_000 + PATRON_LINK_STAGE_MS,
    });
    // The Discord leg's state is spent.
    expect(state.claim(early.flowId, "discord", early.state, t0)).toBeNull();
  });
  it("can be checked without ending or changing them", () => {
    const state = new PatronLinkState();
    const flow = state.startFlow(patron, t0)!;
    expect(state.holds(flow.flowId, "discord", flow.state, t0)).toBe(true);
    for (const [id, stage, value, at] of [
      [flow.flowId, "patreon", flow.state, t0],
      [flow.flowId, "discord", "b".repeat(43), t0],
      [flow.flowId, "discord", [flow.state], t0],
      [flow.flowId, "discord", flow.state, t0 + PATRON_LINK_STAGE_MS],
      [null, "discord", flow.state, t0],
      ["x".repeat(43), "discord", flow.state, t0],
    ] as const)
      expect(state.holds(id, stage, value, at)).toBe(false);
    // None of those checks ended it.
    expect(state.claim(flow.flowId, "discord", flow.state, t0)).not.toBeNull();
  });
  it("end when told to, and stop at 5000 in progress until some expire", () => {
    const state = new PatronLinkState();
    const flow = state.startFlow(patron, t0)!;
    state.end(flow.flowId);
    expect(state.claim(flow.flowId, "discord", flow.state, t0)).toBeNull();
    for (let index = 0; index < PATRON_LINK_MAX_ENTRIES; index++) expect(state.startFlow(patron, t0)).not.toBeNull();
    expect(state.startFlow(patron, t0)).toBeNull();
    expect(state.startFlow(patron, t0 + PATRON_LINK_STAGE_MS)).not.toBeNull();
  });
});

describe("limits", () => {
  it("allow 5 Patreon legs per verified account per 10 minutes", () => {
    const state = new PatronLinkState();
    for (let index = 0; index < PATRON_LINK_LEGS_PER_ACCOUNT; index++) expect(state.startLeg(patron, t0)).toBe(true);
    expect(state.startLeg(patron, t0)).toBe(false);
    expect(state.startLeg(other, t0)).toBe(true);
    expect(state.startLeg(patron, t0 + PATRON_LINK_LIMIT_WINDOW_MS - 1)).toBe(false);
    expect(state.startLeg(patron, t0 + PATRON_LINK_LIMIT_WINDOW_MS)).toBe(true);
  });
  it("count legs for at most 5000 accounts", () => {
    const state = new PatronLinkState();
    for (let index = 0; index < PATRON_LINK_MAX_ENTRIES; index++)
      expect(state.startLeg(String(100000000000000000n + BigInt(index)), t0)).toBe(true);
    expect(state.startLeg(patron, t0)).toBe(false);
    expect(state.startLeg(patron, t0 + PATRON_LINK_LIMIT_WINDOW_MS)).toBe(true);
  });
  it("spend at most 30 unmatched Patreon codes a minute", () => {
    const state = new PatronLinkState();
    for (let index = 0; index < PATRON_LINK_BURNS_PER_MINUTE; index++) expect(state.burnAllowed(t0)).toBe(true);
    expect(state.burnAllowed(t0 + 59_999)).toBe(false);
    expect(state.burnAllowed(t0 + 60_000)).toBe(true);
  });
});

describe("refused Patreon codes", () => {
  it("are refused for an hour from the last time they came without their sign-in, and others still work", () => {
    const state = new PatronLinkState();
    expect(state.codeCheck("lured", t0)).toBe("ok");
    state.refuseCode("lured", t0);
    expect(state.codeCheck("lured", t0)).toBe("refused");
    expect(state.codeCheck("lured", t0 + PATRON_LINK_REFUSED_CODE_MS - 1)).toBe("refused");
    expect(state.codeCheck("other", t0)).toBe("ok");
    // Coming back again without its sign-in starts the hour again.
    state.refuseCode("lured", t0 + 1_000);
    expect(state.codeCheck("lured", t0 + PATRON_LINK_REFUSED_CODE_MS)).toBe("refused");
    expect(state.codeCheck("lured", t0 + 1_000 + PATRON_LINK_REFUSED_CODE_MS)).toBe("ok");
    expect(PATRON_LINK_REFUSED_CODE_MS).toBe(3_600_000);
  });
  it("need no budget: thousands are refused while spending at Patreon is used up", () => {
    const state = new PatronLinkState();
    for (let index = 0; index < PATRON_LINK_BURNS_PER_MINUTE; index++) state.burnAllowed(t0);
    expect(state.burnAllowed(t0)).toBe(false);
    for (let index = 0; index < 5_000; index++) state.refuseCode(`junk-${index}`, t0);
    state.refuseCode("lured", t0);
    expect(state.codeCheck("lured", t0)).toBe("refused");
    expect(state.codeCheck("junk-0", t0)).toBe("refused");
    expect(state.codeCheck("fresh", t0)).toBe("ok");
  });
  it("past the cap, drop the oldest and use no code until it would have expired", () => {
    const state = new PatronLinkState();
    state.refuseCode("first", t0);
    for (let index = 1; index < PATRON_LINK_MAX_REFUSED_CODES; index++) state.refuseCode(`junk-${index}`, t0 + 1);
    expect(state.codeCheck("fresh", t0 + 1)).toBe("ok");
    state.refuseCode("lured", t0 + 2);
    expect(state.codeCheck("lured", t0 + 2)).toBe("refused");
    // "first" was dropped, so no code is trusted until it would have expired.
    expect(state.codeCheck("first", t0 + 2)).toBe("busy");
    expect(state.codeCheck("fresh", t0 + PATRON_LINK_REFUSED_CODE_MS - 1)).toBe("busy");
    expect(state.codeCheck("fresh", t0 + PATRON_LINK_REFUSED_CODE_MS)).toBe("ok");
    expect(state.codeCheck("lured", t0 + PATRON_LINK_REFUSED_CODE_MS)).toBe("refused");
    expect(PATRON_LINK_MAX_REFUSED_CODES).toBe(50_000);
  });
});
