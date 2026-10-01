import { randomUUID } from "node:crypto";
import { AdminService } from "./admin.service";
import { AdminStore } from "./admin.store";
import { RconError } from "./wardogs.client";
import { fixtureServers } from "./game-server-fixture";
import type { Staff } from "./admin.types";
const staff: Staff = { id: "123456789012345678", name: "Admin", role: "admin", csrf: "csrf" };
const input = () => ({
  id: randomUUID(),
  action: "ban",
  steamId: "76561198123456789",
  confirm: "76561198123456789",
  reason: "Repeated abuse",
});
function fixture() {
  const game = { execute: jest.fn().mockResolvedValue({ state: "applied", message: "Ban confirmed" }) };
  const store = {
    begin: jest.fn().mockResolvedValue({ created: true }),
    finish: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AdminService(fixtureServers(game), store as unknown as AdminStore);
  return { game, store, service };
}
describe("staff action safeguards", () => {
  it("enforces permissions and target confirmation before recording or sending", async () => {
    const { service, game, store } = fixture();
    await expect(service.act({ ...staff, role: "viewer" }, input())).rejects.toThrow("staff role");
    await expect(service.act(staff, { ...input(), confirm: "76561198066952872" })).rejects.toThrow("does not match");
    await expect(service.act(staff, { ...input(), steamId: "bad-id", confirm: "bad-id" })).rejects.toThrow("SteamID64");
    await expect(
      service.act(
        { ...staff, role: "moderator" },
        { id: randomUUID(), action: "whitelist-add", steamId: "76561198123456789", reason: "Member" },
      ),
    ).rejects.toThrow("staff role");
    expect(game.execute).not.toHaveBeenCalled();
    expect(store.begin).not.toHaveBeenCalled();
  });
  it("fails closed when the initial audit record cannot be saved", async () => {
    const { service, game, store } = fixture();
    store.begin.mockRejectedValue(new Error("DB offline"));
    await expect(service.act(staff, input())).rejects.toThrow("nothing was sent");
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("does not execute an already recorded request twice", async () => {
    const { service, game, store } = fixture();
    store.begin.mockImplementation(async (_staff, action, requestHash) => ({
      created: false,
      record: { actorId: staff.id, requestHash, state: "applied", message: "Ban confirmed", id: action.id },
    }));
    expect((await service.act(staff, input())).state).toBe("applied");
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("does not replay an unfinished action after a crash", async () => {
    const { service, game, store } = fixture();
    store.begin.mockImplementation(async (_staff, _action, requestHash) => ({
      created: false,
      record: { actorId: staff.id, requestHash, state: "started" },
    }));
    expect((await service.act(staff, input())).state).toBe("unknown");
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("rejects reuse of an action ID with a different request", async () => {
    const { service, game, store } = fixture();
    store.begin.mockResolvedValue({ created: false, record: { actorId: staff.id, requestHash: "different" } });
    await expect(service.act(staff, input())).rejects.toThrow("different request");
    expect(game.execute).not.toHaveBeenCalled();
  });
  it("records uncertain outcomes without another game request", async () => {
    const { service, game, store } = fixture();
    game.execute.mockRejectedValue(new RconError("Lost response", true));
    expect((await service.act(staff, input())).state).toBe("unknown");
    expect(store.finish).toHaveBeenCalledWith(expect.any(String), { state: "unknown", message: "Lost response" });
    expect(game.execute).toHaveBeenCalledTimes(1);
  });
  it("does not claim a completed audit if the final write fails", async () => {
    const { service, game, store } = fixture();
    store.finish.mockRejectedValue(new Error("DB offline"));
    expect((await service.act(staff, input())).state).toBe("unknown");
    expect(game.execute).toHaveBeenCalledTimes(1);
  });
});
