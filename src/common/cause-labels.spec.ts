import {
  CAUSE_KINDS,
  describeCause,
  FIREARM_ITEM_KEYS,
  ITEM_KEYS,
  UNKNOWN_WEAPON,
  type CauseKind,
} from "./cause-labels";

const LABEL = /^[A-Za-z0-9][A-Za-z0-9 '-]{0,39}$/;
const unknown = { label: UNKNOWN_WEAPON, kind: "unknown" };
/** Both prefix casings the game writes. */
const casings = (cause: string) => [cause, cause.replace(/^Id\./, "ID."), cause.replace(/^ID\./, "Id.")];

describe("cause labels", () => {
  it.each<[string, string, CauseKind]>([
    ["Id.Item.AK74M", "AK74", "firearm"],
    ["Id.Item.SR_04", "AMR 50", "firearm"],
    ["Id.Item.WEPN_026", "M1911", "firearm"],
    ["Id.Item.WEPN_027", "Deagle", "firearm"],
    ["Id.Item.WEPN_028", "MP5", "firearm"],
    ["Id.Item.WEPN_029", "Galil", "firearm"],
    ["Id.Item.WEPN_030", "FAL", "firearm"],
    ["Id.Item.WEPN_032", "GGX 18", "firearm"],
    ["Id.Item.WEPN_033", "Bushmaster M17S", "firearm"],
    ["Id.Item.WEPN_035", "Scout Rifle TD", "firearm"],
    ["Id.Item.M4", "M4", "firearm"],
    ["Id.Item.KH2002", "KH-2002", "firearm"],
    ["Id.Item.CGM4", "MAAWS", "explosive"],
    ["Id.Item.Launcher_04", "9K333 Verba", "explosive"],
    ["Id.Item.MMGL", "MGL-40", "explosive"],
    ["Id.Item.Mosin", "Mosin Nagant", "firearm"],
    ["Id.Item.RFB", "BMR-308", "firearm"],
    ["Id.Item.SKS", "SKS", "firearm"],
    ["Id.Item.M249", "M249 SAW", "firearm"],
    ["Id.Item.LMG_02", "PKM", "firearm"],
    ["Id.Item.SVDM", "SVD", "firearm"],
    ["Id.Item.TAR21", "T-21", "firearm"],
    ["Id.Item.MP9", "AMP-9", "firearm"],
    ["Id.Item.SMG_03", "PP-19 Vityaz", "firearm"],
    ["Id.Item.M500", "M500", "firearm"],
    ["Id.Item.MP43", "MP43", "firearm"],
    ["Id.Item.Glock17", "GGX 17", "firearm"],
    ["Id.Item.Judge", "Judge", "firearm"],
    ["Id.Item.A91", "A-91", "firearm"],
    ["Id.Item.MK22", "MK22", "firearm"],
    ["Id.Item.Vector", "Super-45", "firearm"],
    ["Id.Item.CombatBow", "Compound Bow", "firearm"],
    ["Id.Item.M67Grenade", "M67 Frag Grenade", "explosive"],
    ["ID.Item.ATMine", "AT mine", "explosive"],
    ["ID.Item.BuildTool.Hammer.Large", "Big hammer", "tool"],
    ["Id.Vehicle.WeaponExtension.WHL_05.RingTurret", "Ring turret", "vehicle_weapon"],
    ["Vehicle.Variant.Air.Rotary.ROT_04.Default", "Z20 Lakota", "vehicle"],
    ["Vehicle.Variant.Air.Rotary.LittleBird.Default", "MH-6", "vehicle"],
    ["Vehicle.Variant.Land.Wheeled.Humvee.Default", "Humvee", "vehicle"],
  ])("labels %s as %s in either prefix casing", (cause, label, kind) => {
    for (const raw of casings(cause)) expect(describeCause(raw)).toEqual({ label, kind });
    expect(describeCause(`  ${cause.toUpperCase()}  `)).toEqual(describeCause(cause.toLowerCase()));
  });

  it("names unknown codes generically and keeps readable names", () => {
    expect(describeCause("Id.Item.WEPN_7")).toEqual({ label: "Weapon 7", kind: "firearm" });
    expect(describeCause("Id.Item.SMG_09")).toEqual({ label: "SMG-09", kind: "unknown" });
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
      "m500",
      "a91",
      "mk22",
      "vector",
      "sr04",
      "compoundbow",
      "bow",
      "combatbow",
      "wepn026",
      "wepn027",
      "wepn028",
      "wepn029",
      "wepn030",
      "wepn032",
      "wepn033",
      "wepn035",
      "kh2002",
      "lmg02",
      "smg03",
      "mp43",
      "glock17",
      "judge",
      "launcher04",
      "mmgl",
      "cgm4",
      "rpg7",
      "m67",
      "m67grenade",
      "goldm67grenade",
      "c4",
      "c4explosive",
      "ied",
      "iedexplosive",
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
    const vehicles = ["Humvee", "ROT_04", "LittleBird", "Havoc", "Bobcat", "DuneBuggy", "Kodiak", "Ural"].map((code) =>
      describeCause(`Id.Vehicle.${code}`),
    );
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

  it("lists exactly the labelled firearms' keys for the store's long-shot SQL", () => {
    expect(new Set(ITEM_KEYS).size).toBe(ITEM_KEYS.length);
    expect(FIREARM_ITEM_KEYS).toEqual(ITEM_KEYS.filter((key) => describeCause(key).kind === "firearm"));
    for (const key of ITEM_KEYS) {
      // The store binds these as one SQL parameter and compares them with norm()'d item codes.
      expect(key).toMatch(/^[a-z0-9]+$/);
      // The SQL counts every single-segment WEPN_ code as a firearm, so a labelled one must be a firearm too.
      if (/^wepn\d{1,4}$/.test(key)) expect(describeCause(key).kind).toBe("firearm");
    }
    for (const key of FIREARM_ITEM_KEYS) {
      for (const cause of [`Id.Item.${key}`, `ID.Item.${key.toUpperCase()}`, key, key.toUpperCase()])
        expect(describeCause(cause).kind).toBe("firearm");
      // The SQL matches keys only. describeCause() rejects build tools, buildables, blueprint names (BP_, _C)
      // and SteamID-like causes before it looks a key up, so a firearm key that could come from one would
      // count in SQL alone: such a label needs that check added to longShot() in telemetry.store.ts first.
      expect(key).not.toMatch(/^buildtool|buildable|bp|c\d*$|\d{17}/);
    }
    expect(FIREARM_ITEM_KEYS).toEqual(
      expect.arrayContaining(["ak74m", "sr04", "svdm", "mosin", "compoundbow", "m500", "a91", "mk22", "vector"]),
    );
    for (const key of ["cgm4", "rpg7", "m67", "m67grenade", "c4", "atmine", "knife", "fists", "defibrillator"])
      expect(FIREARM_ITEM_KEYS).not.toContain(key);
  });

  it("agrees with a mirror of the store's long-shot SQL on every stored cause shape", () => {
    // telemetry.store.ts longShot(): the item code after "id.item." or a whole bare code (no dot, slash or
    // backslash) has a labelled firearm's norm() key or is a WEPN_ code. Stored causes are trimmed.
    const sqlLongShot = (stored: string) => {
      const cause = stored.toLowerCase();
      const code = cause.startsWith("id.item.") ? cause.slice(8) : /[./\\]/.test(cause) ? null : cause;
      return (
        code !== null && (FIREARM_ITEM_KEYS.includes(code.replace(/[^a-z0-9]/g, "")) || /^wepn_?[0-9]{1,4}$/.test(code))
      );
    };
    const fixed = [
      ...["Id.Item.SMG_03", "SMG_03", "Id.Item.NewRifle", "Id.Item.NewThing.Variant", "Id.Item.", "Id.Item.WEPN_"],
      ...["Id.Item.WEPN_12345", "Id.Item.Foo.WEPN_029", "Id.Item.76561198000000001", "Id.Item.Free_Gun"],
      ...["Id.Item.Mosin.Nagant", "ID.ITEM.SR_04", "id.item.wepn7", "WEPN_030", "Compound Bow", "BP_AK74M"],
      ...["AK74M_C", "Id.Item.Buildable.AK74M", "Id.Item.BuildTool.SVDM", "Id.Vehicle.Item.AK74M", "Item.AK74M"],
      ...["Id.Items.AK74M", "Id.Vehicle.WeaponExtension.Artillery", "Vehicle.Variant.Air.Rotary.ROT_04.Default"],
    ];
    // Deterministic pseudo-random input, so a failure is reproducible.
    let seed = 20261005;
    const next = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    const pieces = [
      ...["Id.Item.", "ID.Item.", "id.ITEM.", "Id.Vehicle.", "Vehicle.Variant.", "WeaponExtension.", "BuildTool."],
      ...["Buildable.", "Buildables", "Item.", "AK74M", "ak-74m", "SVDM", "Mosin", "Nagant", "SR_04", "M500"],
      ...["Compound", "Bow", "RPG7", "M67Grenade", "Knife", "SupplyPallet", "SMG_03", "WEPN_", "WEPN", "029"],
      ...["7", "12345", "76561198000000001", ".", "/", "\\", "_", " ", "-", "BP_", "_C", "free", "a", "Z"],
    ];
    const random = Array.from({ length: 5000 }, () =>
      Array.from({ length: 1 + next(5) }, () => pieces[next(pieces.length)]).join(""),
    );
    for (const cause of [...fixed, ...random].map((value) => value.trim()).filter(Boolean)) {
      const firearm = describeCause(cause).kind === "firearm";
      if (sqlLongShot(cause) !== firearm) throw new Error(`${cause}: SQL ${!firearm}, describeCause ${firearm}`);
    }
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
