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

// Keys are norm() values. Labels use the in-game names. The game's item ids were matched to names with the
// community database at wardogs.zone (built from the game files) on October 5, 2026: for example
// Id.Item.WEPN_029 is the Galil and SR_04 is the AMR 50. Staff can still correct a name from what the game shows.
const ITEMS = table({
  ak74m: ["AK74", "firearm"],
  ak74: ["AK74", "firearm"],
  ak47: ["AK-47", "firearm"],
  akm: ["AKM", "firearm"],
  a91: ["A-91", "firearm"],
  wepn033: ["Bushmaster M17S", "firearm"],
  wepn030: ["FAL", "firearm"],
  wepn029: ["Galil", "firearm"],
  kh2002: ["KH-2002", "firearm"],
  m4: ["M4", "firearm"],
  m4a1: ["M4A1", "firearm"],
  m16: ["M16", "firearm"],
  m16a4: ["M16A4", "firearm"],
  tar21: ["T-21", "firearm"],
  m249: ["M249 SAW", "firearm"],
  lmg02: ["PKM", "firearm"],
  rfb: ["BMR-308", "firearm"],
  sks: ["SKS", "firearm"],
  svdm: ["SVD", "firearm"],
  svd: ["SVD", "firearm"],
  sr04: ["AMR 50", "firearm"],
  mk22: ["MK22", "firearm"],
  mosin: ["Mosin Nagant", "firearm"],
  mosinnagant: ["Mosin Nagant", "firearm"],
  wepn035: ["Scout Rifle TD", "firearm"],
  sv98: ["SV98", "firearm"],
  mp9: ["AMP-9", "firearm"],
  mp5: ["MP5", "firearm"],
  wepn028: ["MP5", "firearm"],
  smg03: ["PP-19 Vityaz", "firearm"],
  vector: ["Super-45", "firearm"],
  m500: ["M500", "firearm"],
  mp43: ["MP43", "firearm"],
  wepn027: ["Deagle", "firearm"],
  glock17: ["GGX 17", "firearm"],
  wepn032: ["GGX 18", "firearm"],
  judge: ["Judge", "firearm"],
  wepn026: ["M1911", "firearm"],
  combatbow: ["Compound Bow", "firearm"],
  compoundbow: ["Compound Bow", "firearm"],
  bow: ["Compound Bow", "firearm"],
  launcher04: ["9K333 Verba", "explosive"],
  cgm4: ["MAAWS", "explosive"],
  mmgl: ["MGL-40", "explosive"],
  rpg7: ["RPG-7", "explosive"],
  m67: ["M67 Frag Grenade", "explosive"],
  m67grenade: ["M67 Frag Grenade", "explosive"],
  goldm67grenade: ["Gold Frag Grenade", "explosive"],
  c4: ["C4 Charge", "explosive"],
  c4explosive: ["C4 Charge", "explosive"],
  ied: ["IED", "explosive"],
  iedexplosive: ["IED", "explosive"],
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
// Vehicle models by in-game name, from the same database. WHL_05 and MBT_01 are not in it yet, so they keep
// generic names.
const VEHICLES = labels({
  humvee: "Humvee",
  rot04: "Z20 Lakota",
  littlebird: "MH-6",
  havoc: "Havoc",
  bobcat: "Bobcat",
  dunebuggy: "Dune Buggy",
  kodiak: "Kodiak",
  ural: "Ural",
});
// Mounted and stationary weapons by in-game name, from the same database.
const MOUNTS = labels({ ringturret: "Ring turret", mistralaa: "Talon 9K-SAM", phalanx: "Vanguard CIWS" });
const BUILDABLES = labels({ barbedwire: "Barbed wire", bremerwall: "Bremer wall", hblock: "H-block" });

/**
 * The labelled firearms' norm() keys. Long shots count firearms only and the store picks the longest kills
 * in SQL, so it mirrors describeCause() there: a cause is a firearm exactly when its item code (the text
 * after `Id.Item.`, or a whole bare code) has one of these keys or is a `WEPN_` code. Unlabelled items,
 * family codes such as SMG_09 and every other kind never count. Built from ITEMS, so a new label updates it.
 */
export const FIREARM_ITEM_KEYS: readonly string[] = [...ITEMS]
  .filter(([, [, kind]]) => kind === "firearm")
  .map(([key]) => key);
/** Every labelled item's norm() key, for the tests that keep the store's SQL mirror exact. */
export const ITEM_KEYS: readonly string[] = [...ITEMS.keys()];

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

/** An unlabelled WEPN_031 reads as "Weapon 031"; other short codes such as SMG_09 read as "SMG-09". */
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
