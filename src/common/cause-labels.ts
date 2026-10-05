// Readable names for the game's kill causes ("Id.Item.AK74M", "ID.Item.AK74M",
// "Vehicle.Variant.Air.Rotary.ROT_04.Default", ...). Shared by the public stats, the weekly Discord
// post and the staff dashboard, so it must stay pure and browser-safe.
//
// Every label matches /^[A-Za-z0-9][A-Za-z0-9 '-]{0,39}$/: no dots or slashes, at most 40 characters,
// never a 17-digit run and never the word "free". Unknown dotted ids and paths read as "Unknown weapon",
// never the raw id.

export type CauseKind =
  | "firearm"
  | "explosive"
  | "melee"
  | "vehicle"
  | "vehicle_weapon"
  | "tool"
  | "environment"
  | "unknown";
export const CAUSE_KINDS: readonly CauseKind[] = [
  "firearm",
  "explosive",
  "melee",
  "vehicle",
  "vehicle_weapon",
  "tool",
  "environment",
  "unknown",
];
export type CauseLabel = { label: string; kind: CauseKind };
export const UNKNOWN_WEAPON = "Unknown weapon";

type Entry = readonly [label: string, kind: CauseKind];
const table = (entries: Record<string, Entry>) => new Map<string, Entry>(Object.entries(entries));
const labels = (entries: Record<string, string>) => new Map<string, string>(Object.entries(entries));

// Keys are norm() values. Names marked "unconfirmed" still need an in-game check by Floh or staff.
const ITEMS = table({
  ak74m: ["AK-74M", "firearm"],
  ak74: ["AK-74", "firearm"],
  ak47: ["AK-47", "firearm"],
  akm: ["AKM", "firearm"],
  m4: ["M4", "firearm"],
  m4a1: ["M4A1", "firearm"],
  m16: ["M16", "firearm"],
  m16a4: ["M16A4", "firearm"],
  mosin: ["Mosin-Nagant", "firearm"],
  mosinnagant: ["Mosin-Nagant", "firearm"],
  rfb: ["RFB", "firearm"],
  sks: ["SKS", "firearm"],
  m249: ["M249", "firearm"],
  svdm: ["SVDM", "firearm"],
  svd: ["SVD", "firearm"],
  sv98: ["SV-98", "firearm"],
  tar21: ["TAR-21", "firearm"],
  mp9: ["MP9", "firearm"],
  mp5: ["MP5", "firearm"],
  m500: ["M500 shotgun", "firearm"],
  a91: ["A-91", "firearm"],
  mk22: ["MK22", "firearm"],
  vector: ["Vector", "firearm"],
  // Unconfirmed: a generic name only.
  sr04: ["SR-04", "firearm"],
  compoundbow: ["Compound bow", "firearm"],
  bow: ["Compound bow", "firearm"],
  // Unconfirmed: assumed to be a Carl Gustaf launcher. If wrong, use "CGM4".
  cgm4: ["Carl Gustaf M4", "explosive"],
  rpg7: ["RPG-7", "explosive"],
  m67: ["M67 grenade", "explosive"],
  m67grenade: ["M67 grenade", "explosive"],
  c4: ["C4", "explosive"],
  ied: ["IED", "explosive"],
  atmine: ["AT mine", "explosive"],
  claymore: ["Claymore", "explosive"],
  smoke: ["Smoke grenade", "explosive"],
  smokegrenade: ["Smoke grenade", "explosive"],
  fists: ["Fists", "melee"],
  fist: ["Fists", "melee"],
  knife: ["Knife", "melee"],
  halligan: ["Halligan bar", "melee"],
  halliganbar: ["Halligan bar", "melee"],
  defibrillator: ["Defibrillator", "tool"],
  defib: ["Defibrillator", "tool"],
  supplypallet: ["Supply pallet", "environment"],
});
const TOOLS = labels({ hammerlarge: "Big hammer", hammersmall: "Hammer", hammer: "Hammer", drill: "Drill" });
// Unconfirmed: ROT_04 and WHL_05 keep generic names.
const VEHICLES = labels({ humvee: "Humvee", rot04: "ROT-04 helicopter" });
const MOUNTS = labels({ ringturret: "Ring turret" });
const BUILDABLES = labels({ barbedwire: "Barbed wire", bremerwall: "Bremer wall", hblock: "H-block" });

/**
 * Long shots count firearms only. The store picks the longest kills in SQL, so it tests causes against
 * these norm() keys of the item table: an `Id.Item.` cause is a long shot unless its key is one of the
 * labelled items of another kind (explosives such as the RPG-7, melee, tools and environment), and a bare
 * code is one only when its key names a labelled firearm. Built from ITEMS, so a new label updates both.
 */
export const NOT_FIREARM_ITEM_KEYS: readonly string[] = [...ITEMS]
  .filter(([, [, kind]]) => kind !== "firearm")
  .map(([key]) => key);
/** The labelled firearms' norm() keys: see NOT_FIREARM_ITEM_KEYS. */
export const FIREARM_ITEM_KEYS: readonly string[] = [...ITEMS]
  .filter(([, [, kind]]) => kind === "firearm")
  .map(([key]) => key);

const STEAM_ID_LIKE = /\p{Nd}{17}/u;
/** Unreal blueprint prefixes and generated class suffixes. Paths and dotted names never reach step 8. */
const INTERNAL = /(?:^|[^A-Za-z])BP_|_C(?:_\d+)?$/;
const UNKNOWN: CauseLabel = { label: UNKNOWN_WEAPON, kind: "unknown" };

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Readable words from raw parts, or null when nothing safe is left: empty, SteamID-like, or using a word
 * the website's copy rules ban. Never changes letter case.
 */
function tidy(parts: readonly string[]): string | null {
  const value = parts
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\s]+/g, " ")
    .replace(/[^A-Za-z0-9 '-]/g, "")
    .replace(/ +/g, " ")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .slice(0, 40)
    .trim();
  return !value || /\d{17}/.test(value) || /\bfree\b/i.test(value) ? null : value;
}

/** WEPN_029 reads as "Weapon 029"; other short codes such as SMG_03 read as "SMG-03". */
function family(segment: string): CauseLabel | null {
  const weapon = /^wepn_?(\d{1,4})$/i.exec(segment);
  if (weapon) return { label: `Weapon ${weapon[1]}`, kind: "firearm" };
  const code = codeLabel(segment);
  return code ? { label: code, kind: "unknown" } : null;
}
function codeLabel(segment: string) {
  const code = /^([a-z]{1,5})_(\d{1,4})$/i.exec(segment);
  return code ? `${code[1].toUpperCase()}-${code[2]}` : null;
}
const item = (key: string): CauseLabel | null => {
  const entry = ITEMS.get(key);
  return entry ? { label: entry[0], kind: entry[1] } : null;
};

/** Pure and case-insensitive: the same cause in any prefix casing gives an identical result. */
export function describeCause(cause: string | null | undefined): CauseLabel {
  if (typeof cause !== "string") return UNKNOWN;
  const s = cause.trim();
  if (!s || s.length > 200 || STEAM_ID_LIKE.test(s)) return UNKNOWN;
  const lower = s.toLowerCase();
  const segments = s.split(".");
  const last = segments.at(-1)!;

  if (lower.startsWith("id.vehicle.weaponextension."))
    return { label: MOUNTS.get(norm(last)) ?? tidy([last]) ?? "Mounted weapon", kind: "vehicle_weapon" };

  if (lower.startsWith("vehicle.variant.")) {
    const [, , , type = "", model = ""] = segments;
    const named = VEHICLES.get(norm(model));
    if (named) return { label: named, kind: "vehicle" };
    const base = norm(model) === "default" ? null : (codeLabel(model) ?? tidy([model]));
    const label = base && norm(type) === "rotary" ? tidy([base, "helicopter"]) : base;
    return { label: label ?? "Vehicle", kind: "vehicle" };
  }

  if (lower.startsWith("id.vehicle.")) {
    const rest = segments.slice(2);
    const named = rest.map((segment) => VEHICLES.get(norm(segment))).find(Boolean);
    const model = rest.filter((segment) => norm(segment) !== "default").at(-1);
    return { label: named ?? (model ? tidy([model]) : null) ?? "Vehicle", kind: "vehicle" };
  }

  if (segments.some((segment) => ["buildable", "buildables"].includes(norm(segment))))
    return { label: BUILDABLES.get(norm(last)) ?? tidy([last]) ?? "Fortification", kind: "environment" };

  if (lower.startsWith("id.item.buildtool.")) {
    const rest = segments.slice(3);
    return { label: TOOLS.get(norm(rest.join(""))) ?? tidy(rest) ?? "Tool", kind: "tool" };
  }

  if (lower.startsWith("id.item.")) {
    const rest = segments.slice(2);
    const known = item(norm(rest.join(""))) ?? (rest.length === 1 ? family(rest[0]) : null);
    if (known) return known;
    const label = tidy(rest);
    return label ? { label, kind: "unknown" } : UNKNOWN;
  }

  if (!/[./\\]/.test(s)) {
    if (INTERNAL.test(s)) return UNKNOWN;
    const known = item(norm(s)) ?? family(s);
    if (known) return known;
    const label = tidy([s]);
    return label ? { label, kind: "unknown" } : UNKNOWN;
  }

  return UNKNOWN;
}
