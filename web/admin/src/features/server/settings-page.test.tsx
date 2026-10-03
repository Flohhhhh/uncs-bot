import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SettingsPage, PermissionsPage } from "./settings-page";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context } from "../players/test-fixtures";
import { settingFields, type SettingsSnapshot } from "../../../../../src/common/server-settings";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const sample: SettingsSnapshot = {
  revision: "r1",
  writable: true,
  notice: "",
  scoreTick: { current: 24, min: 18, max: 30 },
  fields: settingFields.map((field) => ({
    id: field.id,
    value:
      field.id === "serverName"
        ? "The UNCs"
        : field.id === "scorePeriod"
          ? 24
          : field.secret
            ? null
            : field.type === "number"
              ? 0
              : field.type === "boolean"
                ? true
                : "",
    editable: true,
    note: "",
    state: "next-match",
  })),
  rotation: {
    editable: true,
    note: "",
    currentIndex: 0,
    nextIndex: 1,
    currentMap: "Kavkazi",
    enabled: true,
    mode: "Ordered",
    entries: [
      { map: "Kavkazi", experiences: [] },
      { map: "Europe", experiences: ["KOTH_InfantryOnly"] },
    ],
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  request.mockImplementation(async (path) => {
    if (path === "settings") return structuredClone(sample) as never;
    if (path === "catalog")
      return {
        maps: [{ id: "Kavkazi" }, { id: "Europe" }],
        lightings: [{ id: "DayClear" }],
        experiences: [{ id: "KOTH_InfantryOnly" }],
      } as never;
    if (path.startsWith("catalog/maps/")) return { experiences: [{ id: "KOTH_InfantryOnly" }], zones: null } as never;
    if (path === "actions") return { state: "pending", message: "Saved for next match." } as never;
    throw new Error(`Unexpected path ${path}`);
  });
});
const show = (role: "viewer" | "moderator" | "admin" = "admin", path = "/settings") => {
  const state = context();
  state.me.role = role;
  return render(
    <AdminContext.Provider value={state}>
      <MemoryRouter initialEntries={[path]}>
        <SettingsPage />
      </MemoryRouter>
    </AdminContext.Provider>,
  );
};
it("announces a failed settings read without announcing the read while it loads", async () => {
  request.mockRejectedValue(new Error("Server settings could not be read."));
  show();
  expect(screen.getByText("Loading server settings…").closest("[role=alert]")).toBeNull();
  expect(await screen.findByRole("alert")).toHaveTextContent("Server settings could not be read.");
});
it("reviews changed values and records the save without extra typing", async () => {
  show();
  const name = await screen.findByRole("textbox", { name: /Server name/ });
  fireEvent.change(name, { target: { value: "The UNCs Events" } });
  expect(request.mock.calls.some(([path]) => path === "actions")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const dialog = screen.getByRole("dialog");
  expect(within(within(dialog).getByRole("list", { name: "Next match" })).getByRole("listitem")).toHaveTextContent(
    "Server name: The UNCs → The UNCs Events",
  );
  expect(dialog).not.toHaveTextContent(/Changes marked Now/);
  expect(screen.queryByRole("textbox", { name: "Reason" })).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Save settings" }));
  await screen.findByText("Saved for next match.");
  const sent = request.mock.calls.filter(([path]) => path === "actions");
  expect(sent).toHaveLength(1);
  expect(JSON.parse(String(sent[0][1]?.body))).toMatchObject({
    action: "settings-save",
    revision: "r1",
    changes: { serverName: "The UNCs Events" },
    reason: "Staff reviewed server changes.",
  });
  expect(within(dialog).queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
  const id = JSON.parse(String(sent[0][1]?.body)).id;
  request.mockResolvedValueOnce({ record: { id, state: "pending", message: "Still awaiting the next match." } });
  fireEvent.click(within(dialog).getByText("Action details"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Check saved result" }));
  expect(await within(dialog).findByRole("status", { name: "Saved action result" })).toHaveTextContent(
    "Still awaiting the next match.",
  );
  expect(request.mock.calls.filter(([path]) => path === "actions")).toHaveLength(1);
});
it.each(["viewer", "moderator"] as const)("does not request private settings for %s", (role) => {
  show(role);
  expect(screen.getByText("Administrator access required")).toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});

it.each([false, true])("keeps a settings draft after a definite rejection (HTTP: %s)", async (http) => {
  show();
  fireEvent.change(await screen.findByRole("textbox", { name: /Server name/ }), {
    target: { value: "The UNCs Events" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const fallback = request.getMockImplementation()!;
  request.mockImplementation(async (path, options) => {
    if (path !== "actions") return fallback(path, options);
    if (http) throw Object.assign(new Error("Settings rejected"), { status: 422 });
    return { state: "failed", message: "Settings rejected" } as never;
  });
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save settings" }));
  await screen.findByText(/Settings rejected/);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Back to edits" }));
  expect(screen.getByRole("textbox", { name: /Server name/ })).toHaveValue("The UNCs Events");
  expect(screen.getByRole("button", { name: "Review changes" })).toBeEnabled();
  expect(request.mock.calls.filter(([path]) => path === "actions")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save settings" }));
  await screen.findByText("Settings rejected");
  const attempts = request.mock.calls
    .filter(([path]) => path === "actions")
    .map(([, options]) => JSON.parse(String(options?.body)));
  expect(attempts).toHaveLength(2);
  expect(attempts[0].id).not.toBe(attempts[1].id);
  expect(attempts[1].changes).toEqual(attempts[0].changes);
});

it.each(["pending", "unknown", "invalid-state", "timeout"])(
  "does not leave a one-click retry for a possibly saved change (%s)",
  async (state) => {
    show();
    fireEvent.change(await screen.findByRole("textbox", { name: /Server name/ }), {
      target: { value: "The UNCs Events" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (path, options) => {
      if (path !== "actions") return fallback(path, options);
      if (state === "timeout") throw new Error("Timed out");
      return { state, message: "Result received" } as never;
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save settings" }));
    await screen.findByText(state === "timeout" ? "Timed out" : "Result received");
    if (state !== "pending") expect(screen.getByText(/Check this receipt/)).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("button", { name: "Review changes" })).not.toBeInTheDocument();
    expect(request.mock.calls.filter(([path]) => path === "actions")).toHaveLength(1);
  },
);

it("shows the running scoring interval and server range", async () => {
  show();
  fireEvent.click(await screen.findByRole("tab", { name: "Gameplay" }));
  const input = screen.getByRole("spinbutton", { name: /Scoring interval/ });
  expect(input).toHaveAttribute("min", "18");
  expect(input).toHaveAttribute("max", "30");
  expect(screen.getByText("Running: 24s · Allowed: 18–30s")).toBeInTheDocument();
});
it("keeps join passwords out of review text", async () => {
  show();
  fireEvent.click(await screen.findByRole("tab", { name: "Joining" }));
  fireEvent.change(screen.getByPlaceholderText("Leave unchanged"), { target: { value: "test-password-not-real" } });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  expect(screen.getByRole("dialog")).not.toHaveTextContent("test-password-not-real");
  expect(screen.getByRole("dialog")).toHaveTextContent("Password updated");
});
it("shows permissions without reading the live game", () => {
  render(
    <AdminContext.Provider value={context()}>
      <PermissionsPage />
    </AdminContext.Provider>,
  );
  expect(screen.getByText("Staff permissions")).toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});
it("retains an unknown receipt without resending after a lost settings response", async () => {
  const original = request.getMockImplementation()!;
  request.mockImplementation((path, options) =>
    path === "actions" ? Promise.reject(new Error("Connection lost")) : original(path, options),
  );
  show();
  fireEvent.change(await screen.findByRole("textbox", { name: /Server name/ }), { target: { value: "Event night" } });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const dialog = screen.getByRole("dialog");
  expect(screen.queryByRole("textbox", { name: "Reason" })).not.toBeInTheDocument();
  const form = within(dialog).getByRole("button", { name: "Save settings" }).closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  await within(dialog).findByText(/Connection lost/);
  expect(request.mock.calls.filter(([path]) => path === "actions")).toHaveLength(1);
  expect(within(dialog).queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
});
it("keeps slider and exact value together and removes changes when restored", async () => {
  show();
  fireEvent.click(await screen.findByRole("tab", { name: "Gameplay" }));
  const slider = screen.getByRole("slider", { name: "Scoring interval slider" });
  const number = screen.getByRole("spinbutton", { name: "Scoring interval (seconds)" });
  fireEvent.change(slider, { target: { value: "25" } });
  expect(number).toHaveValue(25);
  expect(slider).toHaveAttribute("aria-valuetext", "25 seconds");
  fireEvent.change(number, { target: { value: "26" } });
  expect(slider).toHaveValue("26");
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  expect(within(screen.getByRole("dialog")).getByRole("list", { name: "Next match" })).toHaveTextContent(
    "Scoring interval (seconds): 24s → 26s",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.change(number, { target: { value: "24" } });
  expect(screen.queryByRole("button", { name: "Review changes" })).not.toBeInTheDocument();
  expect(request.mock.calls.some(([path]) => path === "actions")).toBe(false);
});
it("rejects exact scoring values outside the server's range", async () => {
  show();
  fireEvent.click(await screen.findByRole("tab", { name: "Gameplay" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: /Scoring interval/ }), { target: { value: "31" } });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  expect(screen.getByRole("alert")).toHaveTextContent("18 to 30 seconds");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("rejects a join password the game would read back as redacted", async () => {
  show();
  fireEvent.click(await screen.findByRole("tab", { name: "Joining" }));
  fireEvent.change(screen.getByLabelText("Join password"), { target: { value: "****" } });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  expect(screen.getByRole("alert")).toHaveTextContent("That join password is reserved; choose another.");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("clearing a replacement leaves the password unchanged; removing it is explicit", async () => {
  show();
  fireEvent.click(await screen.findByRole("tab", { name: "Joining" }));
  const password = screen.getByLabelText("Join password");
  fireEvent.change(password, { target: { value: "sample-not-a-secret" } });
  fireEvent.change(password, { target: { value: "" } });
  expect(screen.queryByRole("button", { name: "Review changes" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear join password" }));
  expect(password).toHaveAttribute("placeholder", "Password will be removed");
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Password removed");
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await screen.findByText("Saved for next match.");
  expect(JSON.parse(String(request.mock.calls.find(([path]) => path === "actions")![1]?.body)).changes).toEqual({
    serverPassword: "",
  });
});
it("uses switches for on/off settings and marks changed fields and their group", async () => {
  show();
  fireEvent.click(await screen.findByRole("tab", { name: "Gameplay" }));
  const lock = screen.getByRole("switch", { name: "Lock overpopulated teams" });
  expect(lock).toBeChecked();
  expect(screen.queryByRole("combobox", { name: "Lock overpopulated teams" })).not.toBeInTheDocument();
  const field = lock.closest(".setting-field")!;
  expect(field.querySelector(".setting-head")).toHaveTextContent("Lock overpopulated teams⏭ Next match");
  expect(field).not.toHaveClass("is-changed");
  fireEvent.click(lock);
  expect(lock).not.toBeChecked();
  expect(field).toHaveClass("is-changed");
  expect(within(field as HTMLElement).getByText("was On")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Gameplay, unsaved", selected: true })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Identity" })).toBeInTheDocument();
  fireEvent.click(lock);
  expect(field).not.toHaveClass("is-changed");
  expect(screen.getByRole("tab", { name: "Gameplay" })).toBeInTheDocument();
  expect(request.mock.calls.some(([path]) => path === "actions")).toBe(false);
});
it("groups the review by when each change applies", async () => {
  const fallback = request.getMockImplementation()!;
  request.mockImplementation(async (path, options) => {
    if (path !== "settings") return fallback(path, options);
    const snapshot = structuredClone(sample);
    const states: Record<string, string> = {
      lockOverpopulated: "live",
      minRequiredPlayers: "next-match",
      scorePeriod: "next-restart",
    };
    snapshot.fields = snapshot.fields.map((field) => ({ ...field, state: states[field.id] ?? field.state }));
    return snapshot as never;
  });
  show();
  fireEvent.click(await screen.findByRole("tab", { name: "Gameplay" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Scoring interval (seconds)" }), { target: { value: "26" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: /Players to start a match/ }), { target: { value: "60" } });
  fireEvent.click(screen.getByRole("switch", { name: "Lock overpopulated teams" }));
  expect(screen.getByText("was 0")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
    "Applies now",
    "Next match",
    "After restart",
  ]);
  expect(dialog.getByRole("list", { name: "Applies now" })).toHaveTextContent("Lock overpopulated teams: On → Off");
  expect(dialog.getByRole("list", { name: "Next match" })).toHaveTextContent("Players to start a match: 0 → 60");
  expect(dialog.getByRole("list", { name: "After restart" })).toHaveTextContent(
    "Scoring interval (seconds): 24s → 26s",
  );
  expect(request.mock.calls.some(([path]) => path === "actions")).toBe(false);
});
it("keeps only the rotation switches in Settings and links to the editor on the selected server", async () => {
  show("admin", "/settings?server=primary#rotation");
  expect(await screen.findByRole("tab", { name: "Rotation", selected: true })).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Enable map rotation" })).toBeChecked();
  expect(screen.getByRole("combobox", { name: "Rotation order" })).toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "Rotation queue" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit rotation" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Edit maps in Match & maps →" })).toHaveAttribute(
    "href",
    "/match?server=primary&view=rotation",
  );
  expect(request.mock.calls.map(([path]) => path)).toEqual(["settings"]);
});
it("lists host-managed controls one per line with the restart guide", async () => {
  show();
  fireEvent.click(await screen.findByRole("tab", { name: "Host controls" }));
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  const list = screen.getAllByRole("listitem");
  expect(list.map((item) => item.querySelector("strong")?.textContent)).toEqual([
    "Daily restart time",
    "Restart after the match",
    "RCON hosts, port, password and TLS",
    "Game-event feed",
    "Server description",
  ]);
  expect(screen.getByRole("link", { name: "Setup guide ↗" })).toHaveAttribute(
    "href",
    "https://www.xrealm.com/en/blog/wardogs-server-restart-after-match-end",
  );
});
