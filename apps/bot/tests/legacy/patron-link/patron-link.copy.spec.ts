import { createHash } from "node:crypto";
import {
  BUTTON_LABELS,
  isPatronLinkOutcome,
  issuedReply,
  OUTCOME_COPY,
  PAGE_FOOTER,
  PAGE_STYLE_SOURCE,
  PAGE_TITLE,
  panelMessage,
  PATRON_COPY,
  PATRON_LINK_BUTTON,
  PATRON_LINK_OUTCOMES,
  READINESS_COPY,
  resultPage,
  STAFF_COPY,
} from "../../../src/patron-link/patron-link.copy";

const guildId = "200000000000000001";
const link = `https://admin.theuncs.example/supporters/link/start?t=${"a".repeat(43)}`;

function everyLine() {
  const issued = issuedReply(link);
  const panel = panelMessage();
  return [
    ...Object.values(PATRON_COPY),
    ...Object.values(STAFF_COPY),
    ...Object.values(READINESS_COPY),
    ...Object.values(BUTTON_LABELS),
    ...Object.values(OUTCOME_COPY).flatMap(({ title, body }) => [title, body]),
    PAGE_TITLE,
    PAGE_FOOTER,
    issued.content,
    panel.content,
    ...[...issued.components, ...panel.components].flatMap((row) =>
      row.components.map((button) => JSON.stringify(button.toJSON())),
    ),
  ];
}

describe("Link Patreon copy", () => {
  it("never says free, and never promises perks, whitelist or game access", () => {
    for (const line of everyLine()) expect(line).not.toMatch(/\bfree|whitelist|priority|reward|\bperk/i);
  });
  it("keeps staff text to plain sentences without semicolons", () => {
    for (const line of [...Object.values(STAFF_COPY), ...Object.values(READINESS_COPY)]) {
      expect(line).not.toContain(";");
      expect(line.match(/[.!?](\s|$)/g) ?? []).toHaveLength(1);
    }
  });
  it("keeps every button to three words or fewer", () => {
    for (const label of Object.values(BUTTON_LABELS)) expect(label.split(/\s+/).length).toBeLessThanOrEqual(3);
  });
  it("gives the patron a private link button and the fine print, mentioning nobody", () => {
    const reply = issuedReply(link);
    expect(reply.content).toBe(
      "🔗 Your link works once, for 10 minutes, only for you. Sign in to Discord, then Patreon, and Gramps handles the roles. Easier than assembling a grill.\n-# Gramps only checks your membership. He never sees your card or keeps your Patreon login.",
    );
    expect(reply.content).not.toContain("<@");
    expect(reply.components[0].components.map((button) => button.toJSON())).toEqual([
      expect.objectContaining({ label: "Link my Patreon", url: link, style: 5 }),
    ]);
  });
  it("builds a panel with one stable button and no mentions", () => {
    const panel = panelMessage();
    expect(panel.allowedMentions).toEqual({ parse: [] });
    expect(panel.content).toContain("**Patreon supporters, grab your roles here.**");
    expect(panel.content).toContain(PATRON_COPY.finePrint);
    expect(panel.content).not.toContain("<@");
    expect(panel.components[0].components.map((button) => button.toJSON())).toEqual([
      expect.objectContaining({ custom_id: "uncs-patreon/link", label: "Link Patreon" }),
    ]);
    expect(PATRON_LINK_BUTTON).toBe("uncs-patreon/link");
  });
  it("has a title and text for every outcome, and knows only those outcomes", () => {
    expect(Object.keys(OUTCOME_COPY).sort()).toEqual([...PATRON_LINK_OUTCOMES].sort());
    for (const outcome of PATRON_LINK_OUTCOMES) expect(isPatronLinkOutcome(outcome)).toBe(true);
    for (const value of ["", "LINKED", "toString", "__proto__", ["linked"], null])
      expect(isPatronLinkOutcome(value)).toBe(false);
  });
});

describe("the result page", () => {
  it.each([...PATRON_LINK_OUTCOMES])("shows fixed, escaped text for %s with no script, form or image", (outcome) => {
    const page = resultPage(outcome, guildId);
    const { title, body } = OUTCOME_COPY[outcome];
    const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;");
    expect(page).toContain(`<title>Link Patreon · The UNCs</title>`);
    expect(page).toContain(`<h1>${escaped(title)}</h1>`);
    expect(page).toContain(`<p>${escaped(body)}</p>`);
    expect(page).toContain(`href="https://discord.com/channels/${guildId}" rel="noreferrer">Back to Discord</a>`);
    expect(page).toContain(`<p class="footer">Gramps never keeps your Patreon login.</p>`);
    expect(page).not.toMatch(/<script|<form|<img|<iframe|\son[a-z]+=|javascript:/i);
    expect(page.match(/<style>/g)).toHaveLength(1);
  });
  it("escapes everything it prints", () => {
    expect(resultPage("wrong_account", guildId)).toContain("don&#39;t use it");
    expect(resultPage("linked", guildId)).toContain("You&#39;re linked 🎉");
  });
  it("only links to a numeric server, and otherwise to Discord itself", () => {
    expect(resultPage("off", '"><script>alert(1)</script>')).toContain('href="https://discord.com/app"');
    expect(resultPage("off", undefined)).toContain('href="https://discord.com/app"');
  });
  it("names its style by the hash the Content-Security-Policy allows", () => {
    const style = /<style>([\s\S]*)<\/style>/.exec(resultPage("linked", guildId))![1];
    expect(PAGE_STYLE_SOURCE).toBe(`'sha256-${createHash("sha256").update(style).digest("base64")}'`);
  });
});
