import { createHash } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

/** Stable custom ID, so panels already posted in Discord keep working across restarts and deploys. */
export const PATRON_LINK_BUTTON = "uncs-patreon/link";

/** How a sign-in ended. Each one has fixed text on the result page, and none of them carries anything the patron sent. */
export const PATRON_LINK_OUTCOMES = [
  "linked",
  "pending",
  "already",
  "not_member",
  "conflict",
  "wrong_account",
  "expired",
  "declined",
  "off",
  "unavailable",
  "busy",
] as const;
export type PatronLinkOutcome = (typeof PATRON_LINK_OUTCOMES)[number];
export const isPatronLinkOutcome = (value: unknown): value is PatronLinkOutcome =>
  typeof value === "string" && (PATRON_LINK_OUTCOMES as readonly string[]).includes(value);

const FINE_PRINT = "-# Gramps only checks your membership. He never sees your card or keeps your Patreon login.";

/** Private replies to the patron who ran /patreon link or tapped the panel button. */
export const PATRON_COPY = {
  issued:
    "🔗 Your link works once, for 10 minutes, only for you. Sign in to Discord, then Patreon, and Gramps handles the roles. Easier than assembling a grill.",
  already: "✅ You're already linked. Nothing left to do but feel smug.",
  alreadyFinePrint: "-# Wrong Patreon account? Ask an admin to swap it.",
  off: "Patreon linking is switched off right now. Check back later.",
  notSetUp: "Patreon linking isn't set up yet. Give an admin a nudge.",
  limited: "Easy, unc. That's a lot of links for one sitting. Try again in 10 minutes.",
  wrongServer: "This only works in The UNCs Discord.",
  failed: "Gramps tripped over the cord. Try again in a minute.",
  finePrint: FINE_PRINT,
} as const;

/** Private replies to the admin who ran /patreon panel. */
export const STAFF_COPY = {
  adminsOnly: "Only admins can post this panel.",
  posted: "✅ Panel posted.",
  channel: "Gramps can't post in this channel.",
  refused: "Discord refused the panel, so check Gramps' permissions here.",
  unknown: "Discord didn't confirm the panel, so check this channel before posting again.",
} as const;

/** Why linking is not ready, for staff, in the order PatronLinkService.readiness() checks. */
export const READINESS_COPY = {
  import: "The Patreon import isn't set up.",
  clientId: "PATREON_CLIENT_ID is missing or malformed.",
  clientSecret: "PATREON_CLIENT_SECRET is missing, malformed or reused.",
  signIn: "ADMIN_ORIGIN or the Discord sign-in settings need attention.",
  roles: "Discord roles are off or the Supporter role isn't set.",
} as const;

export const BUTTON_LABELS = { issued: "Link my Patreon", panel: "Link Patreon", back: "Back to Discord" } as const;

/** The result page's title and text for each outcome. */
export const OUTCOME_COPY: Record<PatronLinkOutcome, { title: string; body: string }> = {
  linked: {
    title: "You're linked 🎉",
    body: "Patreon and Discord are now on speaking terms. Roles land in a minute or two.",
  },
  pending: { title: "You're linked", body: "Roles follow once Patreon confirms a payment." },
  already: { title: "Already linked", body: "These two were already acquainted." },
  not_member: {
    title: "No membership found",
    body: "No UNCs membership on that Patreon account. Just joined? Give it a minute.",
  },
  conflict: {
    title: "This one needs a human",
    body: "That account is linked elsewhere, and Gramps never overwrites links. An admin will sort it out.",
  },
  wrong_account: {
    title: "Wrong Discord account",
    body: "This link belongs to someone else. If someone sent it to you, don't use it.",
  },
  expired: { title: "Link expired", body: "Links last 10 minutes, like a good nap. Run /patreon link again." },
  declined: { title: "Nothing linked", body: "You said no. Fair enough." },
  off: { title: "Linking is off", body: "Nothing changed." },
  unavailable: { title: "Patreon or Discord didn't answer", body: "Nothing was linked. Try again shortly." },
  busy: { title: "Too many tries", body: "Gramps needs a breather. Try again shortly." },
};
export const PAGE_TITLE = "Link Patreon · The UNCs";
export const PAGE_FOOTER = "Gramps never keeps your Patreon login.";

/** The patron's one-time link, as a private reply with a link button. */
export function issuedReply(url: string) {
  return {
    content: `${PATRON_COPY.issued}\n${FINE_PRINT}`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel(BUTTON_LABELS.issued).setStyle(ButtonStyle.Link).setURL(url),
      ),
    ],
  };
}

/** The persistent panel admins post with /patreon panel. It mentions nobody. */
export function panelMessage() {
  return {
    content: [
      "**Patreon supporters, grab your roles here.** Tap **Link Patreon**, sign in to Discord and Patreon, and Gramps hands over your Supporter role. Takes about as long as finding your reading glasses.",
      FINE_PRINT,
    ].join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(PATRON_LINK_BUTTON)
          .setLabel(BUTTON_LABELS.panel)
          .setEmoji("🔗")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
    allowedMentions: { parse: [] as [] },
  };
}

/** The page's only style. The Content-Security-Policy allows exactly this text by its hash, and no script at all. */
const PAGE_STYLE = [
  ":root{color-scheme:light dark;--bg:#f4f1ea;--card:#fffdf8;--text:#2b2620;--muted:#6b6257;--accent:#5865f2}",
  "@media (prefers-color-scheme:dark){:root{--bg:#1c1b19;--card:#262421;--text:#f1ece4;--muted:#b3aa9e}}",
  "*{box-sizing:border-box}",
  "body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
  "main{width:100%;max-width:420px;background:var(--card);border-radius:16px;padding:32px 24px;text-align:center;box-shadow:0 8px 24px rgb(0 0 0/.12)}",
  "h1{margin:0 0 12px;font-size:1.5rem;line-height:1.25}",
  "p{margin:0 0 24px;color:var(--muted)}",
  ".button{display:inline-block;padding:12px 24px;border-radius:999px;background:var(--accent);color:#fff;font-weight:600;text-decoration:none}",
  ".footer{margin:24px 0 0;font-size:.85rem}",
].join("");
/** The CSP source for PAGE_STYLE. */
export const PAGE_STYLE_SOURCE = `'sha256-${createHash("sha256").update(PAGE_STYLE).digest("base64")}'`;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const html = (value: string) => value.replace(/[&<>"']/g, (character) => ESCAPES[character]);

/**
 * The result page: fixed text for one outcome and a button back to The UNCs Discord. Everything is escaped, nothing
 * comes from the request, and there is no script, form or image.
 */
export function resultPage(outcome: PatronLinkOutcome, guildId: string | null | undefined) {
  const { title, body } = OUTCOME_COPY[outcome];
  const back =
    guildId && /^\d{17,20}$/.test(guildId) ? `https://discord.com/channels/${guildId}` : "https://discord.com/app";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${html(PAGE_TITLE)}</title>`,
    `<style>${PAGE_STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    `<h1>${html(title)}</h1>`,
    `<p>${html(body)}</p>`,
    `<a class="button" href="${html(back)}" rel="noreferrer">${html(BUTTON_LABELS.back)}</a>`,
    `<p class="footer">${html(PAGE_FOOTER)}</p>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}
