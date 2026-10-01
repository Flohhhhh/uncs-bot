import { randomUUID } from "node:crypto";
import { isPublicIndividualSteamId } from "../common/steam-id";
import { applicationSchema } from "../applications/applications.types";
import { actionSchema, bansSchema, playersSchema, reservedSchema, steamId } from "./admin.types";

describe("public individual SteamID64 validation", () => {
  it.each(["76561197960265729", "76561199999999999", "76561200000000000", "76561202255233023"])(
    "accepts the full structural range without claiming account ownership: %s",
    (value) => {
      expect(isPublicIndividualSteamId(value)).toBe(true);
      expect(steamId.parse(value)).toBe(value);
      expect(
        actionSchema.parse({ id: randomUUID(), action: "whitelist-add", steamId: value, reason: "Requested access" }),
      ).toMatchObject({ steamId: value });
      expect(playersSchema.parse({ players: [{ name: "Player", steamId: value }] }).players[0].steamId).toBe(value);
      expect(bansSchema.parse({ bans: [{ steamId: value }] }).bans[0].steamId).toBe(value);
      expect(reservedSchema.parse({ reservedSlots: [value] }).reservedSlots).toEqual([value]);
      expect(
        applicationSchema.parse({
          steamId: value,
          relationship: "new_player",
          rulesAccepted: true,
          contactConsent: true,
        }).steamId,
      ).toBe(value);
    },
  );

  it.each([
    "0",
    "76561197960265728",
    "76561190000000001",
    "76561202255233024",
    "76561193665298433",
    "76561202255233025",
    "103582791429521409",
    " 76561200000000000",
    "76561200000000000\n",
    "+76561200000000000",
    "076561200000000000",
    "7.65612e16",
    "７６５６１２０００００００００００",
    "7656120000000000x",
    76561200000000000,
    76561200000000000n,
    null,
    undefined,
    {},
    ["76561200000000000"],
  ])("rejects non-personal or noncanonical IDs without coercion: %p", (value) => {
    expect(isPublicIndividualSteamId(value)).toBe(false);
    expect(steamId.safeParse(value).success).toBe(false);
  });
});
