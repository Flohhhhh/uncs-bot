import { configuredWhitelist, editWhitelist, inspectConfiguredWhitelist } from "./whitelist-document";
const existing = "76561198066952872",
  added = "76561198123456789";
const document = {
  revision: "r1",
  writable: true,
  text: [
    "; hosting panel comment",
    "[/Script/WDGame.WDGameSession]",
    "ServerName=The UNCs",
    "MaxReservedSlots=0",
    `+DefaultReservedPlayerIds=${existing}`,
    "+DefaultBannedPlayerIds=76561198157040394",
    "",
    "[/Script/WDRCON.WDRCONSettings]",
    "Password=must-remain-server-side",
    "",
    "[WDServerFeed]",
    "Url=http://127.0.0.1:32190",
    "Token=unchanged",
  ].join("\r\n"),
};
const unrelatedLines = (text: string) =>
  text.split(/\r?\n/).filter((line) => !/^\s*[+.!-]?DefaultReservedPlayerIds\s*=/i.test(line));

describe("targeted whitelist edits", () => {
  it("reads valid saved IDs beside a short numeric ID but still refuses to rewrite that document", () => {
    const text = document.text.replace(
      `+DefaultReservedPlayerIds=${existing}`,
      `!DefaultReservedPlayerIds=ClearArray\r\n.DefaultReservedPlayerIds=7656119800000000\r\n.DefaultReservedPlayerIds=${existing}`,
    );
    expect(inspectConfiguredWhitelist(text)).toEqual({ ids: [existing], invalidEntryCount: 1 });
    expect(() => configuredWhitelist(text)).toThrow("unsupported");
    expect(() => editWhitelist({ ...document, text }, added, true)).toThrow("unsupported");
    expect(() => inspectConfiguredWhitelist(text + "\r\n[/Script/WDGame.WDGameSession]")).toThrow("ambiguous");
    const cleared = text.replace(
      `.DefaultReservedPlayerIds=${existing}`,
      `!DefaultReservedPlayerIds=ClearArray\r\n.DefaultReservedPlayerIds=${existing}`,
    );
    expect(inspectConfiguredWhitelist(cleared)).toEqual({ ids: [existing], invalidEntryCount: 0 });
  });
  it("preserves valid IDs beyond the old prefix through add and remove", () => {
    const nextId = "76561200000000000";
    const updated = editWhitelist(document, nextId, true);
    expect(configuredWhitelist(updated)).toEqual([existing, nextId]);
    expect(unrelatedLines(updated)).toEqual(unrelatedLines(document.text));
    expect(configuredWhitelist(editWhitelist({ ...document, text: updated }, existing, false))).toEqual([nextId]);
  });
  it.each(["76561197960265728", "76561202255233024", "76561190000000001"])(
    "refuses out-of-range existing values before rewriting: %s",
    (value) => {
      const text = document.text.replace(existing, value);
      expect(() => configuredWhitelist(text)).toThrow("unsupported");
      expect(() => editWhitelist({ ...document, text }, added, true)).toThrow("unsupported");
      expect(() => editWhitelist(document, value, true)).toThrow("Invalid SteamID64");
    },
  );
  it("adds one ID and preserves every existing setting and entry", () => {
    const updated = editWhitelist(document, added, true);
    expect(configuredWhitelist(updated)).toEqual([existing, added]);
    expect(unrelatedLines(updated)).toEqual(unrelatedLines(document.text));
    expect(updated).toContain("!DefaultReservedPlayerIds=ClearArray");
  });
  it("removes only the requested ID, including duplicate instances", () => {
    const doc = {
      ...document,
      text: document.text.replace(
        `+DefaultReservedPlayerIds=${existing}`,
        `+DefaultReservedPlayerIds=${existing}\r\n+DefaultReservedPlayerIds=${added}\r\n+DefaultReservedPlayerIds=${existing}`,
      ),
    };
    const updated = editWhitelist(doc, existing, false);
    expect(configuredWhitelist(updated)).toEqual([added]);
    expect(updated).toContain("MaxReservedSlots=0");
    expect(updated).toContain("Token=unchanged");
  });
  it("makes additions idempotent", () => expect(editWhitelist(document, existing, true)).toBe(document.text));
  it("supports the current official RCON console's clear and append format", () => {
    const doc = {
      ...document,
      text: document.text.replace(
        `+DefaultReservedPlayerIds=${existing}`,
        `!DefaultReservedPlayerIds=ClearArray\r\n.DefaultReservedPlayerIds=${existing}`,
      ),
    };
    expect(configuredWhitelist(doc.text)).toEqual([existing]);
    const updated = editWhitelist(doc, added, true);
    expect(configuredWhitelist(updated)).toEqual([existing, added]);
    expect(unrelatedLines(updated)).toEqual(unrelatedLines(doc.text));
  });
  it("evaluates clears, removals, scalar replacement and duplicate appends in order", () => {
    const text = [
      "[/Script/WDGame.WDGameSession]",
      `+DefaultReservedPlayerIds=${added}`,
      "!DefaultReservedPlayerIds=ClearArray",
      `+DefaultReservedPlayerIds=${existing}`,
      `.DefaultReservedPlayerIds="${existing}"`,
      `-DefaultReservedPlayerIds=${existing}`,
      `DefaultReservedPlayerIds=${existing}`,
      `+DefaultReservedPlayerIds=${added} // a comment`,
    ].join("\n");
    expect(configuredWhitelist(text)).toEqual([existing, added]);
    const updated = editWhitelist({ ...document, text }, existing, false);
    expect(configuredWhitelist(updated)).toEqual([added]);
  });
  it("explicitly clears the array when removing its last member", () => {
    const updated = editWhitelist(document, existing, false);
    expect(updated).toContain("!DefaultReservedPlayerIds=ClearArray");
    expect(configuredWhitelist(updated)).toEqual([]);
    expect(unrelatedLines(updated)).toEqual(unrelatedLines(document.text));
  });
  it("refuses locked keys, ambiguous sections and unfamiliar array values", () => {
    expect(() => editWhitelist({ ...document, writable: false }, added, true)).toThrow("read-only");
    expect(() =>
      editWhitelist(
        {
          ...document,
          sections: [
            {
              section: "/Script/WDGame.WDGameSession",
              keyOverrides: [{ key: "DefaultReservedPlayerIds", writable: false }],
            },
          ],
        },
        added,
        true,
      ),
    ).toThrow("locked");
    expect(() =>
      editWhitelist({ ...document, text: document.text + "\r\n[/Script/WDGame.WDGameSession]" }, added, true),
    ).toThrow("ambiguous");
    expect(() =>
      editWhitelist(
        {
          ...document,
          text: document.text.replace(`+DefaultReservedPlayerIds=${existing}`, "+DefaultReservedPlayerIds=not-an-id"),
        },
        added,
        true,
      ),
    ).toThrow("unsupported");
  });
  it.each(["***", "<redacted>", "[REDACTED]", "REDACTED"])("refuses redacted %s secret placeholders", (value) => {
    expect(() =>
      editWhitelist({ ...document, text: document.text.replace("Token=unchanged", `Token="${value}"`) }, added, true),
    ).toThrow("redacted");
  });
  it("honors redaction and locked metadata independently of writable=true", () => {
    expect(() => editWhitelist({ ...document, redacted: true }, added, true)).toThrow("redacted");
    expect(() =>
      editWhitelist(
        {
          ...document,
          sections: [{ section: "/Script/WDGame.WDGameSession", allowedKeys: ["ServerName"] }],
        },
        added,
        true,
      ),
    ).toThrow("locked");
    expect(() =>
      editWhitelist(
        {
          ...document,
          sections: [
            {
              section: "/Script/WDGame.WDGameSession",
              keyOverrides: [{ key: ".defaultreservedplayerids", lockedBy: "-FixedReservedList" }],
            },
          ],
        },
        added,
        true,
      ),
    ).toThrow("locked");
  });
});
