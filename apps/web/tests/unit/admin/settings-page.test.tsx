import { expect, it, vi } from "vitest";
const { session } = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("~/lib/session/server", () => ({ readServerSession: session }));
vi.mock("~/app/(admin)/admin/settings/_components/settings-surface", () => ({ SettingsSurface: () => null }));
import SettingsPage from "~/app/(admin)/admin/settings/page";
it("passes the authenticated session CSRF token to the migrated settings surface", async () => {
  session.mockResolvedValue({ status: "authenticated", user: { csrf: "review-token" } });
  expect((await SettingsPage()).props.csrf).toBe("review-token");
  session.mockResolvedValue({ status: "unavailable" });
  expect((await SettingsPage()).props.csrf).toBe("");
});
