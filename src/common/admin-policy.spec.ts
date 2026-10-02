import { staffRoleFor, type StaffPolicy } from "./admin-policy";

const policy: StaffPolicy = {
  ownerIds: ["100000000000000001"],
  adminRoleIds: ["200000000000000001"],
  moderatorRoleIds: ["200000000000000002"],
  viewerRoleIds: ["200000000000000003"],
};

describe("staff role check", () => {
  it("ranks owners and admin roles above moderators and viewers", () => {
    expect(staffRoleFor("100000000000000001", [], policy)).toBe("admin");
    expect(staffRoleFor("100000000000000009", ["200000000000000002", "200000000000000001"], policy)).toBe("admin");
    expect(staffRoleFor("100000000000000009", ["200000000000000003", "200000000000000002"], policy)).toBe("moderator");
    expect(staffRoleFor("100000000000000009", ["200000000000000003"], policy)).toBe("viewer");
  });

  it("grants nothing without a listed owner ID or staff role", () => {
    expect(staffRoleFor("100000000000000009", ["200000000000000009"], policy)).toBeUndefined();
    expect(
      staffRoleFor("100000000000000001", ["200000000000000001"], {
        ownerIds: [],
        adminRoleIds: [],
        moderatorRoleIds: [],
        viewerRoleIds: [],
      }),
    ).toBeUndefined();
  });
});
