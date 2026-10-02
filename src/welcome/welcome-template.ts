/** Returns a number in [0, 1), like `Math.random`. Injected so tests can pick versions deterministically. */
export type RandomSource = () => number;

/** Discord's limit for an embed description; each rendered version is cut to this length. */
export const MAX_WELCOME_DESCRIPTION_LENGTH = 4096;
/** Discord's limit for a message's text, which bounds the staff view of the stored template. */
export const MAX_DISCORD_CONTENT_LENGTH = 2000;

/**
 * Separates versions: `---` on its own between whitespace or the ends of the template. That covers a line
 * holding only `---` and the one-line ` --- ` form, which slash-command options need because they cannot hold
 * line breaks. `||` is deliberately not a separator: Discord uses it for spoilers.
 */
const VERSION_SEPARATOR = /(?<=^|\s)---(?=\s|$)/;

/** A truncated version in the staff view keeps at least this many characters, or is listed as not shown. */
const MIN_VERSION_PREVIEW_LENGTH = 80;

export const DEFAULT_WELCOME_VERSIONS = [
  "{user} just pulled up. Grab a chair, the good one's taken. Say hey in {general}, find a squad in {squad-up}, or hop into **The Lobby**.\n\nPick your games and roles in **Channels & Roles**.",
  "Look who made it, {user}. Knees creak? You're in the right place. Say hey in {general} and find a squad in {squad-up}.\n\nPick your games and roles in **Channels & Roles**.",
  "{user}, welcome to The UNCs. Rated M for Mortgage. Say hey in {general}, squad up in {squad-up}, or jump into **The Lobby** whenever life lets you.\n\nPick your games and roles in **Channels & Roles**.",
  "Welcome, {user}. No tryouts, no attendance, no judgment about your bedtime. Say hey in {general} or find a squad in {squad-up}.\n\nPick your games and roles in **Channels & Roles**.",
  "{user} has entered the chat. Somebody save them a seat. Start in {general}, find a squad in {squad-up}, and when you're ready, skip the server queue: theuncsgaming.com/whitelist\n\nPick your games and roles in **Channels & Roles**.",
] as const;

/** Used when a guild has no stored template. */
export const DEFAULT_WELCOME_MESSAGE = DEFAULT_WELCOME_VERSIONS.join("\n---\n");

/**
 * What staff are told about how versions rotate. The last pick is kept only in memory (see `WelcomeService`),
 * so the first join after a restart can get the version sent just before it.
 */
export const WELCOME_ROTATION_NOTE =
  "Each new member gets one at random, skipping the one sent last unless the bot has restarted since.";

/**
 * Splits a stored template into its versions. Each version is trimmed, empty ones are dropped and a repeat of an
 * earlier version's text is dropped, because a join can only tell versions apart by their text. A template
 * without a separator is returned unchanged as its only version, exactly as it was sent before versions existed.
 */
export function parseWelcomeVersions(template: string): string[] {
  if (!VERSION_SEPARATOR.test(template)) return template.trim() ? [template] : [];
  const versions = template
    .split(VERSION_SEPARATOR)
    .map((version) => version.trim())
    .filter(Boolean);
  return [...new Set(versions)];
}

/** The versions a join can receive: the template's, or the built-in default's when the template has no text. */
export function welcomeVersions(template: string): string[] {
  const versions = parseWelcomeVersions(template);
  return versions.length ? versions : parseWelcomeVersions(DEFAULT_WELCOME_MESSAGE);
}

/**
 * Chooses one version at random. When another version is available it never returns `previous`, so a guild
 * does not get the same text twice in a row. A single candidate is returned without consulting `random`.
 */
export function pickWelcomeVersion(
  versions: readonly string[],
  previous: string | undefined,
  random: RandomSource,
): string {
  if (versions.length === 0) throw new Error("A welcome template needs at least one version");
  const fresh = versions.filter((version) => version !== previous);
  const candidates = fresh.length ? fresh : versions;
  if (candidates.length === 1) return candidates[0];
  const value = random();
  const position = Number.isFinite(value) ? Math.floor(value * candidates.length) : 0;
  return candidates[Math.min(candidates.length - 1, Math.max(0, position))];
}

/** Staff view of a stored template: how many versions it has and each version's text, within `limit`. */
export function describeWelcomeTemplate(template: string, limit = MAX_DISCORD_CONTENT_LENGTH): string {
  const stored = parseWelcomeVersions(template);
  const versions = welcomeVersions(template);
  const count = versions.length === 1 ? "1 version" : `${versions.length} versions`;
  const header = !stored.length
    ? `**Current welcome message:** the saved template has no text, so new members get the built-in default (${count}).`
    : versions.length === 1
      ? "**Current welcome message:** 1 version. Add more by separating them with ` --- ` (see `/welcome help`)."
      : `**Current welcome message:** ${count}. ${WELCOME_ROTATION_NOTE}`;
  const footer = "Stored in Neon PostgreSQL.";
  const blocks = versions.map((version, index) =>
    versions.length === 1 ? version : `**Version ${index + 1}**\n${version}`,
  );
  const join = (parts: string[]) => parts.join("\n\n");
  const notShown = (hidden: number) => `…and ${hidden} more ${hidden === 1 ? "version" : "versions"} not shown.`;

  const shown: string[] = [];
  let hidden = 0;
  for (let index = 0; index < blocks.length; index++) {
    const rest = blocks.length - index - 1;
    const tail = rest ? [notShown(rest), footer] : [footer];
    if (join([header, ...shown, blocks[index], ...tail]).length <= limit) {
      shown.push(blocks[index]);
      continue;
    }
    const room = limit - join([header, ...shown, "", ...tail]).length;
    if (room >= MIN_VERSION_PREVIEW_LENGTH) {
      shown.push(truncate(blocks[index], room));
      hidden = rest;
    } else {
      hidden = rest + 1;
    }
    break;
  }

  const description = join([header, ...shown, ...(hidden ? [notShown(hidden)] : []), footer]);
  return truncate(description, limit);
}

function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}
