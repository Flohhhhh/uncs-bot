import type { ConfigDocument } from "./admin.types";

const sectionName = "/Script/WDGame.WDGameSession";
const key = "DefaultReservedPlayerIds";
const normalizeKey = (value: string) =>
  value
    .trim()
    .replace(/^[+.!-]\s*/, "")
    .toLowerCase();

// Work on only the one array. Do not round-trip the whole INI through a parser:
// unrelated comments, credentials, host settings and ordering must survive intact.
function locate(text: string) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const starts = lines.flatMap((line, index) =>
    line.trim().toLowerCase() === `[${sectionName.toLowerCase()}]` ? [index] : [],
  );
  if (starts.length !== 1)
    throw new Error("The whitelist section is missing or ambiguous. Review it in the host panel.");
  const start = starts[0] + 1;
  let end = lines.findIndex((line, index) => index >= start && /^\s*\[/.test(line));
  if (end === -1) end = lines.length;
  const indices: number[] = [];
  let ids: string[] = [];
  for (let index = start; index < end; index++) {
    const line = lines[index];
    if (!/^\s*[+.!-]?\s*DefaultReservedPlayerIds\s*=/i.test(line)) continue;
    const match = line.match(
      /^\s*([+.!-]?)\s*DefaultReservedPlayerIds\s*=\s*(?:"(7656119\d{10}|ClearArray)"|(7656119\d{10}|ClearArray))\s*(?:(?:[;#]|\/\/).*)?$/i,
    );
    if (!match) throw new Error("The whitelist uses an unsupported array format. Review it in the host panel.");
    const operator = match[1];
    const value = match[2] ?? match[3];
    if ((operator === "!") !== (value.toLowerCase() === "cleararray"))
      throw new Error("The whitelist uses an unsupported array format. Review it in the host panel.");
    indices.push(index);
    // Match Unreal's documented array commands, also used by the official RCON
    // console. Its serializer emits !ClearArray and .Key, not just +Key.
    if (operator === "!") ids = [];
    else if (operator === "-") ids = ids.filter((id) => id !== value);
    else if (operator === "") ids = [value];
    else if (operator === "." || !ids.includes(value)) ids.push(value);
  }
  return { lines, newline, end, indices, ids: [...new Set(ids)] };
}

export function configuredWhitelist(text: string) {
  return locate(text).ids;
}

export function editWhitelist(document: ConfigDocument, steamId: string, add: boolean) {
  if (!/^7656119\d{10}$/.test(steamId)) throw new Error("Invalid SteamID64.");
  if (!document.writable) throw new Error("The game reports that its configuration is read-only.");
  if (
    document.redacted ||
    /^\s*[^;#\r\n][^=\r\n]*=\s*"?(?:\*{3,}|<redacted>|\[redacted\]|redacted)"?\s*(?:(?:[;#]|\/\/).*)?$/im.test(
      document.text,
    )
  )
    throw new Error(
      "The game returned a redacted configuration. A safe whitelist edit cannot be made from this document.",
    );
  const section = document.sections?.find(
    (entry) => entry.section.replace(/^\[|\]$/g, "").toLowerCase() === sectionName.toLowerCase(),
  );
  const override = section?.keyOverrides?.find((entry) => normalizeKey(entry.key) === key.toLowerCase());
  if (
    section?.writable === false ||
    override?.writable === false ||
    !!override?.lockedBy ||
    (section?.allowedKeys && !section.allowedKeys.some((value) => normalizeKey(value) === key.toLowerCase()))
  ) {
    throw new Error("The host has locked whitelist changes.");
  }
  const { lines, newline, end, indices, ids } = locate(document.text);
  if (ids.includes(steamId) === add) return document.text;
  const next = add ? [...ids, steamId] : ids.filter((id) => id !== steamId);
  const insertion = indices[0] ?? end;
  for (const index of indices.reverse()) lines.splice(index, 1);
  // Explicit clearing is required when the last entry is removed; an omitted
  // key can leave an inherited/previous array in place. Change only this key.
  lines.splice(insertion, 0, `!${key}=ClearArray`, ...next.map((id) => `.${key}=${id}`));
  return lines.join(newline);
}
