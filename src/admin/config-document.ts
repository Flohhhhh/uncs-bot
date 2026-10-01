import type { ConfigDocument } from "./admin.types";

const normalized = (value: string) =>
  value
    .replace(/^\[|\]$/g, "")
    .replace(/^[+.!-]\s*/, "")
    .toLowerCase();
export function assertEditable(document: ConfigDocument, sectionName: string, key: string) {
  if (!document.writable) throw new Error("The server configuration is read-only.");
  if (
    document.redacted ||
    /^\s*[^;#\r\n][^=\r\n]*=\s*"?(?:\*{3,}|<redacted>|\[redacted\]|redacted)"?\s*(?:(?:[;#]|\/\/).*)?$/im.test(
      document.text,
    )
  )
    throw new Error("The configuration is redacted. Edit it through the host panel.");
  const sections = document.sections?.filter((entry) => normalized(entry.section) === normalized(sectionName)) ?? [];
  if (sections.length > 1) throw new Error("The server returned ambiguous configuration permissions.");
  const section = sections[0];
  const overrides = section?.keyOverrides?.filter((entry) => normalized(entry.key) === normalized(key)) ?? [];
  if (
    section?.writable === false ||
    overrides.some((entry) => entry.writable === false || entry.lockedBy) ||
    (section?.allowedKeys && !section.allowedKeys.some((value) => normalized(value) === normalized(key)))
  )
    throw new Error("This setting is locked by the host.");
}

// Preserve every unrelated byte, including credentials, feed destinations and comments.
function locate(text: string, section: string, key: string) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const starts = lines.flatMap((line, i) => (line.trim().toLowerCase() === `[${section.toLowerCase()}]` ? [i] : []));
  if (starts.length !== 1) throw new Error("The configuration section is missing or ambiguous. Check the host panel.");
  const start = starts[0] + 1;
  let end = lines.findIndex((line, i) => i >= start && /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  const entries: { index: number; operator: string; value: string }[] = [];
  for (let index = start; index < end; index++) {
    const match = lines[index].match(/^\s*([+.!-]?)\s*([^=;#\s]+)\s*=(.*)$/);
    if (match && match[2].toLowerCase() === key.toLowerCase())
      entries.push({ index, operator: match[1], value: match[3].trim() });
  }
  return { newline, lines, end, entries };
}
export function scalarValue(text: string, section: string, key: string): string | null {
  const { entries } = locate(text, section, key);
  if (entries.some((entry) => entry.operator) || entries.length > 1)
    throw new Error("This setting uses an ambiguous format. Check the host panel.");
  if (!entries.length) return null;
  const value = entries[0].value;
  const quoted = value.match(/^"([^"\\]*)"\s*(?:[;#].*)?$/);
  if (quoted) return quoted[1];
  if (value.includes('"') || value.includes("\\")) throw new Error("This setting uses an unsupported format.");
  return value.replace(/\s+[;#].*$/, "").trim();
}
export function arrayValue(text: string, section: string, key: string): string[] {
  let values: string[] = [];
  for (const { operator, value } of locate(text, section, key).entries) {
    if (operator === "!") {
      if (!/^ClearArray\s*(?:[;#].*)?$/i.test(value)) throw new Error("Unsupported array reset.");
      values = [];
    } else if (operator === "-") values = values.filter((item) => item !== value);
    else if (operator === "") values = [value];
    else if (operator === "." || !values.includes(value)) values.push(value);
  }
  return values;
}
export function editConfigKey(
  document: ConfigDocument,
  section: string,
  key: string,
  value: string | string[],
): string {
  assertEditable(document, section, key);
  const { newline, lines, end, entries } = locate(document.text, section, key);
  const insertion = entries[0]?.index ?? end;
  if (!Array.isArray(value)) scalarValue(document.text, section, key);
  for (const entry of [...entries].reverse()) lines.splice(entry.index, 1);
  lines.splice(
    insertion,
    0,
    ...(Array.isArray(value) ? [`!${key}=ClearArray`, ...value.map((item) => `.${key}=${item}`)] : [`${key}=${value}`]),
  );
  return lines.join(newline);
}
