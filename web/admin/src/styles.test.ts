import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// jsdom does no layout, so these checks read the stylesheet itself: the declared value of a property for a
// selector at a viewport width, in source order, as the browser's cascade would pick it among those rules.
type Rule = { media: string | null; selectors: string[]; declarations: Map<string, string> };

/** Splits at commas or semicolons outside parentheses, such as in `:where(a, b)` or `min(1px, 2px)`. */
function split(text: string, separator: "," | ";") {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")") depth--;
    else if (text[index] === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/** The style rules in source order, each with the @media condition it sits under. */
function parse(source: string) {
  const rules: Rule[] = [];
  const walk = (body: string, media: string | null) => {
    let index = 0;
    for (let open = body.indexOf("{", index); open >= 0; open = body.indexOf("{", index)) {
      let end = open + 1;
      for (let depth = 1; depth; end++) {
        if (body[end] === "{") depth++;
        else if (body[end] === "}") depth--;
      }
      const prelude = body.slice(index, open).trim();
      const inner = body.slice(open + 1, end - 1);
      if (prelude.startsWith("@media")) walk(inner, prelude.slice("@media".length).trim());
      else if (!prelude.startsWith("@"))
        rules.push({
          media,
          selectors: split(prelude, ","),
          declarations: new Map(
            split(inner, ";").map((declaration) => {
              const colon = declaration.indexOf(":");
              return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()] as const;
            }),
          ),
        });
      index = end;
    }
  };
  walk(source.replace(/\/\*[\s\S]*?\*\//g, ""), null);
  return rules;
}
// Read from disk: Vitest does not process CSS, so even a `?raw` import comes back empty.
const rules = parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8"));

/** Width queries only; any other condition, such as reduced motion, is treated as not matching. */
function matches(media: string | null, width: number) {
  if (media === null) return true;
  return media.split(/\s+and\s+/).every((condition) => {
    const query = /^\((max|min)-width:\s*(\d+)px\)$/.exec(condition.trim());
    if (!query) return false;
    return query[1] === "max" ? width <= Number(query[2]) : width >= Number(query[2]);
  });
}

function declared(selector: string, property: string, width: number) {
  let value: string | undefined;
  for (const rule of rules)
    if (rule.selectors.includes(selector) && matches(rule.media, width) && rule.declarations.has(property))
      value = rule.declarations.get(property);
  return value;
}

/** A length in pixels, with custom properties resolved at `width` and the bottom safe-area inset at `inset`. */
function pixels(value: string | undefined, width: number, inset = 0): number {
  if (value === undefined) throw new Error("No declared value");
  const resolved = value
    .replace(
      /var\((--[\w-]+)\)/g,
      (_, name: string) => `(${String(pixels(declared(":root", name, width), width, inset))}px)`,
    )
    .replace(/env\(safe-area-inset-bottom\)/g, `${inset}px`);
  const terms = resolved
    .replace(/calc\(|\(|\)/g, " ")
    .trim()
    .split(/\s+/);
  let total = 0;
  let sign = 1;
  for (const term of terms) {
    if (term === "+" || term === "-") sign = term === "+" ? 1 : -1;
    else if (/^-?\d+(\.\d+)?px$/.test(term)) total += sign * Number.parseFloat(term);
    else throw new Error(`Not a pixel sum: ${value}`);
  }
  return total;
}

describe("phone tab bar", () => {
  const phone = 375;
  it.each([0, 34])("leaves the unsaved-changes bar above the tab bar and a %ipx home indicator", (inset) => {
    // The tab bar is fixed over the bottom of a phone screen: its links, a 1px top border, then the inset.
    const tabBar = pixels(declared(".sections a", "min-height", phone), phone) + 1 + inset;
    expect(pixels(declared("main", "padding-bottom", phone), phone, inset)).toBeGreaterThanOrEqual(tabBar);
    // The settings and rotation drafts share this sticky bar; it must stop 12px above the tab bar, not under it.
    expect(declared(".settings-savebar", "position", phone)).toBe("sticky");
    expect(pixels(declared(".settings-savebar", "bottom", phone), phone, inset)).toBeGreaterThanOrEqual(tabBar + 12);
  });
  it("keeps the unsaved-changes bar 12px from the bottom where there is no tab bar", () => {
    expect(pixels(declared(".settings-savebar", "bottom", 1024), 1024, 34)).toBe(12);
  });
});

describe("Server activity help", () => {
  it.each([320, 375, 390, 741, 820, 950, 1024, 1366])(
    "keeps the open panel inside the content column at %ipx",
    (width) => {
      // The "?" can land anywhere along the status row, so the panel lines up with the row's left edge instead of
      // the toggle's, and is never wider than the row.
      expect(declared(".activity-head", "position", width)).toBe("relative");
      expect(declared(".activity-help", "position", width)).toBeUndefined();
      expect(declared(".activity-help-panel", "position", width)).toBe("absolute");
      expect(declared(".activity-help-panel", "left", width)).toBe("0");
      expect(declared(".activity-help-panel", "right", width)).toBeUndefined();
      expect(declared(".activity-help-panel", "width", width)).toBe("min(380px, 100%)");
    },
  );
});

describe("buttons", () => {
  it("dims an aria-disabled button like a disabled one", () => {
    // The player panel's Check again keeps focus while its check runs, so it is aria-disabled, not disabled.
    const dimmed = 'button[aria-disabled="true"]';
    expect(declared(dimmed, "opacity", 1024)).toBe(declared("button:disabled", "opacity", 1024));
    expect(declared(dimmed, "cursor", 1024)).toBe("not-allowed");
  });
});

describe("Discord roles ledger", () => {
  it.each([320, 375, 700])("wraps a ledger message inside its full-width phone card at %ipx", (width) => {
    // A 220px minimum in a half-width card cell pushed the Recent role changes card into a sideways scroll.
    expect(declared("td small.roles-ledger-message", "min-width", width)).toBe("0");
    expect(declared('[data-mobile="cards"] td:has(.roles-ledger-message)', "grid-column", width)).toBe("1 / -1");
  });
  it("keeps the readable message width in the desktop table", () => {
    expect(declared("td small.roles-ledger-message", "min-width", 1024)).toBe("220px");
    expect(declared('[data-mobile="cards"] td:has(.roles-ledger-message)', "grid-column", 1024)).toBeUndefined();
  });
});
