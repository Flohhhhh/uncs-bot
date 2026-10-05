import { CAUSE_KINDS, describeCause, UNKNOWN_WEAPON, type CauseKind } from "./cause-labels";

const LABEL = /^[A-Za-z0-9][A-Za-z0-9 '-]{0,39}$/;
const unknown = { label: UNKNOWN_WEAPON, kind: "unknown" };
/** Both prefix casings the game writes. */
const casings = (cause: string) => [cause, cause.replace(/^Id\./, "ID."), cause.replace(/^ID\./, "Id.")];

describe("cause labels", () => {
  it.each<[string, string, CauseKind]>([
    ["Id.Item.AK74M", "AK-74M", "firearm"],
    ["Id.Item.SR_04", "SR-04", "firearm"],
    ["Id.Item.WEPN_029", "Weapon 029", "firearm"],
    ["Id.Item.WEPN_030", "Weapon 030", "firearm"],
    ["Id.Item.WEPN_032", "Weapon 032", "firearm"],
    ["Id.Item.M4", "M4", "firearm"],
    ["Id.Item.CGM4", "Carl Gustaf M4", "explosive"],
    ["Id.Item.Mosin", "Mosin-Nagant", "firearm"],
    ["Id.Item.RFB", "RFB", "firearm"],
    ["Id.Item.SKS", "SKS", "firearm"],
    ["Id.Item.M249", "M249", "firearm"],
    ["Id.Item.SVDM", "SVDM", "firearm"],
    ["Id.Item.TAR21", "TAR-21", "firearm"],
    ["Id.Item.MP9", "MP9", "firearm"],
    ["ID.Item.ATMine", "AT mine", "explosive"],
    ["ID.Item.BuildTool.Hammer.Large", "Big hammer", "tool"],
    ["Id.Vehicle.WeaponExtension.WHL_05.RingTurret", "Ring turret", "vehicle_weapon"],
    ["Vehicle.Variant.Air.Rotary.ROT_04.Default", "ROT-04 helicopter", "vehicle"],
    ["Vehicle.Variant.Land.Wheeled.Humvee.Default", "Humvee", "vehicle"],
  ])("labels %s as %s in either prefix casing", (cause, label, kind) => {
    for (const raw of casings(cause)) expect(describeCause(raw)).toEqual({ label, kind });
    expect(describeCause(`  ${cause.toUpperCase()}  `)).toEqual(describeCause(cause.toLowerCase()));
  });

  it("names unknown codes generically and keeps readable names", () => {
    expect(describeCause("Id.Item.WEPN_7")).toEqual({ label: "Weapon 7", kind: "firearm" });
    expect(describeCause("Id.Item.SMG_03")).toEqual({ label: "SMG-03", kind: "unknown" });
    expect(describeCause("Id.Item.NewThing.Variant")).toEqual({ label: "New Thing Variant", kind: "unknown" });
    expect(describeCause("Vehicle.Variant.Air.Rotary.ROT_09.Default")).toEqual({
      label: "ROT-09 helicopter",
      kind: "vehicle",
    });
    expect(describeCause("Vehicle.Variant.Land.Tracked.BigTank.Default")).toEqual({
      label: "Big Tank",
      kind: "vehicle",
    });
    expect(describeCause("Vehicle.Variant.Land")).toEqual({ label: "Vehicle", kind: "vehicle" });
    expect(describeCause("Id.Vehicle.Humvee.Default")).toEqual({ label: "Humvee", kind: "vehicle" });
    expect(describeCause("Id.Vehicle.Quad.Default")).toEqual({ label: "Quad", kind: "vehicle" });
    expect(describeCause("Id.Vehicle.WeaponExtension.WHL_05.TwinGun")).toEqual({
      label: "Twin Gun",
      kind: "vehicle_weapon",
    });
    expect(describeCause("Id.Buildable.BarbedWire")).toEqual({ label: "Barbed wire", kind: "environment" });
    expect(describeCause("Id.Item.Buildables.SandBags")).toEqual({ label: "Sand Bags", kind: "environment" });
    expect(describeCause("ID.Item.BuildTool.Drill")).toEqual({ label: "Drill", kind: "tool" });
    expect(describeCause("ID.Item.SupplyPallet")).toEqual({ label: "Supply pallet", kind: "environment" });
    expect(describeCause("ID.Item.Fists")).toEqual({ label: "Fists", kind: "melee" });
    expect(describeCause("M1 Garand")).toEqual({ label: "M1 Garand", kind: "unknown" });
    expect(describeCause("Grenade_Frag")).toEqual({ label: "Grenade Frag", kind: "unknown" });
    expect(describeCause("knife")).toEqual({ label: "Knife", kind: "melee" });
    expect(describeCause("x".repeat(60))).toEqual({ label: "x".repeat(40), kind: "unknown" });
  });

  it("never shows unknown dotted ids, paths, blueprint names or SteamID-like input", () => {
    for (const raw of [
      "Weapon.Rifle",
      "Meta.Thing.AK74M",
      "/Game/Weapons/M1",
      "/Game/Weapons/M1.M1_C",
      "Weapons\\Rifle",
      "BP_M1Garand_C",
      "Weapon_BP_Rifle",
      "Rifle_C",
      "Rifle_C_2147482",
      "76561198000000001",
      "Id.Item.76561198000000001",
      "Gun 76561198000000001",
      [..."76561198000000001"].map((digit) => String.fromCodePoint(0x0660 + Number(digit))).join(""),
      "***",
      "",
      "   ",
      "x".repeat(201),
      "Free Fire",
      "Id.Item.Free_Gun",
      null,
      undefined,
    ])
      expect(describeCause(raw)).toEqual(unknown);
    expect(describeCause(5 as unknown as string)).toEqual(unknown);
    // Digits split by a character tidy drops still never form a 17-digit label.
    expect(describeCause("Id.Item.12345678901234é567")).toEqual(unknown);
  });

  it("keeps every known label inside the public label rules", () => {
    const known = [
      "AK74M",
      "ak74",
      "ak47",
      "akm",
      "m4",
      "m4a1",
      "m16",
      "m16a4",
      "mosin",
      "mosinnagant",
      "rfb",
      "sks",
      "m249",
      "svdm",
      "svd",
      "sv98",
      "tar21",
      "mp9",
      "mp5",
      "sr04",
      "compoundbow",
      "bow",
      "cgm4",
      "rpg7",
      "m67",
      "c4",
      "ied",
      "atmine",
      "claymore",
      "smoke",
      "smokegrenade",
      "fists",
      "fist",
      "knife",
      "halligan",
      "halliganbar",
      "defibrillator",
      "defib",
      "supplypallet",
    ].map((code) => describeCause(`Id.Item.${code}`));
    const vehicles = ["Humvee", "ROT_04"].map((code) => describeCause(`Id.Vehicle.${code}`));
    const mounts = [describeCause("Id.Vehicle.WeaponExtension.X.RingTurret")];
    const tools = ["Hammer.Large", "Hammer.Small", "Hammer", "Drill"].map((code) =>
      describeCause(`Id.Item.BuildTool.${code}`),
    );
    const buildables = ["BarbedWire", "BremerWall", "HBlock"].map((code) => describeCause(`Id.Buildable.${code}`));
    for (const { label, kind } of [...known, ...vehicles, ...mounts, ...tools, ...buildables]) {
      expect(label).toMatch(LABEL);
      expect(label).not.toMatch(/\bfree\b/i);
      expect(label).not.toBe(UNKNOWN_WEAPON);
      expect(CAUSE_KINDS).toContain(kind);
    }
    expect(known.map(({ kind }) => kind)).not.toContain("unknown");
  });

  it("never returns a dot, slash, 17-digit run or more than 40 characters for random input", () => {
    // Deterministic pseudo-random input, so a failure is reproducible.
    let seed = 20261006;
    const next = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    const pieces = [
      "Id.",
      "ID.",
      "Item.",
      "Vehicle.",
      "Variant.",
      "WeaponExtension.",
      "BuildTool.",
      "Buildable.",
      "Rotary.",
      ".",
      "/",
      "\\",
      "_",
      " ",
      "BP_",
      "_C",
      "WEPN_",
      "76561198000000001",
      "12345678",
      "٣٤٥٦٧٨٩",
      "１２３４５",
      "AK74M",
      "Ä",
      "é",
      "'",
      "-",
      "free",
      "Free Fire",
      "<@123>",
      "😀",
      "a",
      "Z",
      "9",
    ];
    for (let run = 0; run < 500; run++) {
      const input = Array.from({ length: 1 + next(12) }, () => pieces[next(pieces.length)]).join("");
      const { label, kind } = describeCause(input);
      expect(label).toMatch(LABEL);
      expect(label).not.toMatch(/[./\\]/);
      expect(label).not.toMatch(/\p{Nd}{17}/u);
      expect(label).not.toMatch(/\bfree\b/i);
      expect(label.length).toBeLessThanOrEqual(40);
      expect(CAUSE_KINDS).toContain(kind);
    }
  });
});
