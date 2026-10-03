import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext, type AdminContextValue } from "../../app/context";
import { alice, bob, cara, context } from "../players/test-fixtures";
import { OverviewPage } from "./pages";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const rotation = {
  enabled: true,
  mode: "Ordered",
  editable: true,
  note: "",
  currentMap: "Harbor",
  currentIndex: 0,
  nextIndex: 1,
  entries: [
    { map: "Harbor", experiences: [] },
    { map: "Ozeti", experiences: [], lighting: "DayClear" },
  ],
};
let reads: Record<string, unknown>;
beforeEach(() => {
  request.mockReset();
  reads = {
    activity: {
      connection: "available",
      limit: 300,
      startedAt: "2026-09-30T17:00:00Z",
      events: [
        {
          id: "join",
          observedAt: "2026-09-30T17:59:00Z",
          category: "players",
          message: "Cara joined",
          steamId: cara.steamId,
        },
      ],
    },
    "audit-notable": [],
    settings: { revision: "r1", fields: [], rotation },
    "map-votes": { enabled: true, serverId: "primary", votes: [] },
  };
  request.mockImplementation(async (path) =>
    path in reads ? (reads[path] as never) : Promise.reject(new Error(`Unexpected read ${path}`)),
  );
});
function show(admin: AdminContextValue = context()) {
  return render(
    <MemoryRouter initialEntries={["/overview?server=primary"]}>
      <AdminContext.Provider value={admin}>
        <OverviewPage />
      </AdminContext.Provider>
    </MemoryRouter>,
  );
}

it("opens the chosen overview player's panel without making staff search again", async () => {
  const admin = context();
  show(admin);
  const players = screen.getByRole("list", { name: "Players on this server" });
  fireEvent.click(within(players).getByRole("button", { name: bob.name }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(bob.steamId)).toBeInTheDocument();
  expect(within(dialog).queryByText(alice.steamId)).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Message player" }));
  expect(admin.openAction).toHaveBeenCalledWith("message", bob.steamId);
  await screen.findByText("Saved next round");
});
it("shows the live match at a glance with an honest round clock and the saved next round", async () => {
  show();
  const now = screen.getByRole("region", { name: "Now" });
  expect(within(now).getByText("3")).toBeInTheDocument();
  expect(within(now).getByText("Harbor")).toBeInTheDocument();
  expect(within(now).getByText("2:00 elapsed")).toBeInTheDocument();
  expect(within(now).getByText(/^checked /)).toBeInTheDocument();
  expect(await within(now).findByText("Ozeti · Day clear")).toBeInTheDocument();
  expect(within(now).getByText("Saved next round")).toBeInTheDocument();
  expect(within(now).getByText("None")).toBeInTheDocument();
  expect(screen.queryByText(/YOUR ACCESS|SERVER STATUS|WARDOGS|STAFF TOOLS/i)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send an announcement" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Add to whitelist" })).toBeEnabled();
});
it("does not invent a round clock or a next round it cannot confirm", async () => {
  const admin = context();
  delete admin.overview!.status.matchSeconds;
  reads.settings = { revision: "r1", fields: [], rotation: { ...rotation, currentMap: "Ozeti" } };
  show(admin);
  const now = screen.getByRole("region", { name: "Now" });
  expect(within(now).getByText("No clock")).toBeInTheDocument();
  expect(await within(now).findByText("Not confirmed")).toBeInTheDocument();
  expect(within(now).queryByText("Saved next round")).not.toBeInTheDocument();
});
it("treats a failed settings read as unavailable and shows an open vote", async () => {
  reads.settings = undefined;
  reads["map-votes"] = {
    enabled: true,
    serverId: "primary",
    votes: [{ state: "open", closesAt: "2026-09-30T18:12:00Z", automation: null }],
  };
  request.mockImplementation(async (path) =>
    path === "settings" ? Promise.reject(new Error("Settings unavailable")) : (reads[path] as never),
  );
  show();
  const now = screen.getByRole("region", { name: "Now" });
  expect(await within(now).findByText("Settings could not be read")).toBeInTheDocument();
  expect(within(now).getByText("Unavailable")).toBeInTheDocument();
  expect(within(now).getByText(/^Open · ends /)).toBeInTheDocument();
});
it("shows recent non-combat activity and labels scores with live team colors", async () => {
  show();
  const activity = screen.getByRole("link", { name: "All activity →" });
  expect(activity).toHaveAttribute("href", "/activity?server=primary");
  const line = await screen.findByText(
    (_, element) => element?.className === "activity-line" && element.textContent === "Cara joined",
  );
  fireEvent.click(within(line).getByRole("button", { name: "Cara" }));
  expect(within(screen.getByRole("dialog")).getByText(cara.steamId)).toBeInTheDocument();
  expect(screen.getByText("Red · Valkyra", { selector: ".overview-scores .faction-chip" })).toBeInTheDocument();
  expect(request.mock.calls.map(([path]) => path)).not.toContain("combat?period=day");
});
it("hides admin-only reads from moderators and takes their next round from the running rotation", async () => {
  reads.rotation = {
    enabled: true,
    mode: "Ordered",
    entries: [
      { index: 0, map: "Harbor", status: "now" },
      { index: 1, map: "Ozeti", lighting: "DayClear", status: "next" },
    ],
  };
  const admin = context();
  admin.me.role = "moderator";
  show(admin);
  const now = screen.getByRole("region", { name: "Now" });
  expect(await within(now).findByText("Ozeti · Day clear")).toBeInTheDocument();
  expect(within(now).queryByText("Vote")).not.toBeInTheDocument();
  const paths = request.mock.calls.map(([path]) => path);
  expect(paths).toContain("rotation");
  expect(paths).not.toContain("settings");
  expect(paths).not.toContain("map-votes");
});
it("does not name a next round when a moderator's rotation read fails", async () => {
  request.mockImplementation(async (path) =>
    path === "rotation" ? Promise.reject(new Error("Rotation unavailable")) : (reads[path] as never),
  );
  const admin = context();
  admin.me.role = "moderator";
  show(admin);
  const now = screen.getByRole("region", { name: "Now" });
  expect(await within(now).findByText("Rotation could not be read")).toBeInTheDocument();
  expect(within(now).getByText("Unavailable")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(/Next round\s*Unavailable\s*Rotation could not be read/);
});
it("announces failed overview reads to screen readers but keeps loading quiet", async () => {
  const failing = ["activity", "audit-notable", "settings", "map-votes"];
  request.mockImplementation(async (path) =>
    failing.includes(path) ? Promise.reject(new Error(`${path} unavailable`)) : (reads[path] as never),
  );
  show();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText("Loading recent activity…").closest("[role=alert]")).toBeNull();
  const now = screen.getByRole("region", { name: "Now" });
  for (const checking of within(now).getAllByText("Checking…")) expect(checking.closest("[role=alert]")).toBeNull();
  const activity = await screen.findByText("Recent activity could not be loaded.");
  expect(activity).toHaveAttribute("role", "alert");
  const settings = await within(now).findByText("Settings could not be read");
  expect(settings.closest("[role=alert]")).toHaveTextContent(/Next round\s*Unavailable/);
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(3));
  expect(within(now).getByText("Vote").closest("[role=alert]")).toHaveTextContent(/Vote\s*Unavailable/);
});
it("keeps successful overview reads out of the alert queue", async () => {
  show();
  await screen.findByText("Saved next round");
  await screen.findByText(
    (_, element) => element?.className === "activity-line" && element.textContent === "Cara joined",
  );
  expect(within(screen.getByRole("region", { name: "Now" })).getByText("None")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
