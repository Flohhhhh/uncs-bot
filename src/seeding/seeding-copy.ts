import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

/** Stable custom IDs, so panels already posted in Discord keep working across restarts and deploys. */
export const SEEDING_BUTTONS = { join: "uncs-seeding/join", leave: "uncs-seeding/leave" } as const;
export const SEEDING_NOTE_MAX_LENGTH = 200;
export const SEEDING_WEBSITE = "https://theuncsgaming.com";

export type RoleProblem = "missing" | "unsafe" | "unassignable" | "unavailable";
export type ChannelProblem = "unusable" | "cannot-mention";

/** Private replies to the member who ran /seeding join or leave or pressed a panel button. */
export const MEMBER_COPY = {
  joined:
    "🌱 You're a Seeder now. When the WARDOGS server is quiet, staff may ping you to help get a match going. Had enough? `/seeding leave` or **Stop pinging me**.",
  alreadyJoined: "You're already a Seeder. Signing up twice won't double the pings, scout's honor.",
  left: "👋 Done, no more seeding pings. If your knees change their mind, `/seeding join` or **I'll help seed** brings you back.",
  alreadyLeft: "You're not on the Seeder list, so there's nothing to stop. Peace and quiet, as ordered.",
  off: "Seeding sign-ups are switched off right now, so nobody's getting pinged. Check back later.",
  unconfigured: "Seeding isn't set up yet. Staff are still reading the instructions, glasses on. Give them a nudge.",
  outsideGuild: "This only works inside The UNCs Discord. Pop over there and try again.",
  notMember: "I couldn't find you in The UNCs Discord. Join the server first, then try again.",
  roleMissing:
    "The Seeder role has wandered off, like reading glasses on top of someone's head. Let a staff member know.",
  roleUnusable: "The Seeder role isn't set up right, so I'm leaving it alone. Let a staff member know.",
  roleTooLow:
    "Gramps can't reach the Seeder role on the top shelf. Let a staff member know so they can move it below Gramps.",
  failed: "Something went sideways with the role. Give it a minute and try again.",
} as const;

/** Private replies to staff for /seeding panel, ping and status. */
export const STAFF_COPY = {
  staffOnly: "That one's for staff only. Nice try, unc.",
  off: "Seeding is switched off (`SEEDING_ENABLED=false`). Turn it on first.",
  guildUnset: "Seeding needs `ADMIN_GUILD_ID` before anything works.",
  roleUnset: "Set `SEEDING_ROLE_ID` first.",
  pingUnset: "Set `SEEDING_ROLE_ID` and `SEEDING_PING_CHANNEL_ID` first.",
  panelChannel:
    "Gramps can't post the panel here. Use a text or announcement channel in this server where Gramps has View Channel and Send Messages.",
  panelPosted: "✅ Panel posted. Members can opt in or out with the buttons.",
  panelRefused: "Discord refused the panel, so nothing was posted. Check Gramps' permissions in this channel.",
  panelUnknown: "Discord didn't confirm the panel. Check this channel before posting another.",
  failed: "Something went sideways and nothing was posted. Try again in a minute.",
  pingSent: (channelId: string, cooldownMs: number) =>
    `📣 Seeding call sent in <#${channelId}>. The next one opens in ${formatDuration(cooldownMs)}.`,
  pingRefused: (channelId: string) =>
    `Discord refused the ping, so nothing was posted in <#${channelId}> and the cooldown wasn't used. Check Gramps' permissions there.`,
  pingUnknown: (channelId: string) =>
    `Discord didn't confirm the ping. Check <#${channelId}> before doing anything else: Gramps won't resend it, and the cooldown still applies.`,
  cooldown: (remainingMs: number) =>
    `Easy, unc, the last call went out recently. The next seeding ping opens in ${formatDuration(remainingMs)}.`,
};

export const ROLE_PROBLEMS: Record<RoleProblem, string> = {
  missing: "Seeder role not found. Check `SEEDING_ROLE_ID`.",
  unsafe:
    "The Seeder role isn't safe to hand out: it's @everyone, a managed or staff role, or has moderation permissions. Use a plain role with no permissions.",
  unassignable:
    "Gramps can't assign the Seeder role. Give Gramps Manage Roles and drag Seeder below Gramps in Server Settings → Roles.",
  unavailable: "Discord didn't answer about the Seeder role. Try again shortly.",
};

export const CHANNEL_PROBLEMS: Record<ChannelProblem, string> = {
  unusable:
    "Gramps can't post in the ping channel. Use a text or announcement channel in this server where Gramps has View Channel and Send Messages.",
  "cannot-mention":
    "Gramps can't mention Seeder in the ping channel. Give Gramps Mention @everyone, @here and All Roles there; the ping still mentions only Seeder.",
};

export const MENTIONABLE_WARNING =
  "-# Heads-up: anyone can @mention Seeder. Turn off **Allow anyone to @mention this role** so only staff pings reach it.";

/** Whole minutes, rounded up so a refusal never undersells the wait. */
export function formatDuration(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Zero-width and bidirectional formatting characters, which can hide or reorder text. */
function invisible(code: number) {
  return (
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * One short line for the staff note: no control characters, line breaks or invisible formatting, no user or
 * role mentions and no @everyone or @here. allowedMentions already blocks every ping but Seeder's; this keeps
 * the text itself clean too. Returns undefined when nothing is left.
 */
export function sanitizeNote(note: string | null | undefined) {
  if (!note) return undefined;
  const cleaned = [...note]
    .map((character) => {
      const code = character.charCodeAt(0);
      if (invisible(code)) return "";
      return code < 32 || (code >= 127 && code < 160) ? " " : character;
    })
    .join("")
    .replace(/<@[!&]?\d+>/g, " ")
    .replace(/@+(?=everyone|here)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...cleaned].slice(0, SEEDING_NOTE_MAX_LENGTH).join("").trim() || undefined;
}

export type SeedingCall = {
  roleId: string;
  players: { current: number; max: number } | null;
  joinId?: string;
  note?: string;
};

/** The staff-triggered call. The role mention is the only mention; the caller restricts allowedMentions to it. */
export function seedingCall({ roleId, players, joinId, note }: SeedingCall) {
  const lines = [
    `<@&${roleId}> **Seeders, it's go time.** The WARDOGS server is quieter than an early-bird dinner at 3:45. Come help get a match going.`,
  ];
  if (players) lines.push(`Players on right now: **${players.current}/${players.max}**`);
  lines.push(
    joinId
      ? `Join by ID: \`${joinId}\` (the **Join by ID** button is bottom-left in the server browser)`
      : `How to join: ${SEEDING_WEBSITE}`,
  );
  if (note) lines.push(`Staff note: ${note}`);
  lines.push("-# You get these because you joined the Seeder role. `/seeding leave` turns them off.");
  return lines.join("\n");
}

/** The persistent opt-in panel staff post with /seeding panel. It mentions nobody. */
export function panelMessage() {
  return {
    content: [
      "**🌱 Help seed the WARDOGS server**",
      "A quiet server just needs a few early risers to get a match going. Lucky for us, we're up at 5 a.m. anyway.",
      "Want a ping when staff call for seeders? Tap **I'll help seed**. Had enough? Tap **Stop pinging me**.",
      "-# Staff send these pings by hand, only when the server is quiet. Opt out anytime.",
    ].join("\n"),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(SEEDING_BUTTONS.join)
          .setLabel("I'll help seed")
          .setEmoji("🌱")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(SEEDING_BUTTONS.leave)
          .setLabel("Stop pinging me")
          .setEmoji("🔕")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] as [] },
  };
}
