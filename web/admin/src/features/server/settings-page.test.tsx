import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
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
it("reviews changed values and records the save without extra typing", async () => {
  show();
  const name = await screen.findByRole("textbox", { name: /Server name/ });
  fireEvent.change(name, { target: { value: "The UNCs Events" } });
  expect(request.mock.calls.some(([path]) => path === "actions")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Server name: The UNCs → The UNCs Events · Next match")).toBeInTheDocument();
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

it("preserves reordered maps after a rejected rotation save", async () => {
  show("admin", "/settings#rotation");
  fireEvent.click(await screen.findByRole("button", { name: "Move Europe up" }));
  fireEvent.click(screen.getByRole("button", { name: "Review rotation" }));
  const fallback = request.getMockImplementation()!;
  request.mockImplementation(async (path, options) =>
    path === "actions" ? ({ state: "failed", message: "Rotation rejected" } as never) : fallback(path, options),
  );
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save rotation" }));
  await screen.findByText("Rotation rejected");
  fireEvent.click(screen.getByRole("button", { name: "Back to edits" }));
  expect(screen.getByRole("button", { name: "Review rotation" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Review rotation" }));
  const changes = within(screen.getByRole("dialog")).getAllByRole("listitem");
  expect(changes[0]).toHaveTextContent("Europe");
});
it("shows the running scoring interval and server range", async () => {
  show();
  await screen.findByRole("button", { name: "Gameplay" });
  fireEvent.click(screen.getByRole("button", { name: "Gameplay" }));
  const input = screen.getByRole("spinbutton", { name: /Scoring interval/ });
  expect(input).toHaveAttribute("min", "18");
  expect(input).toHaveAttribute("max", "30");
  expect(screen.getByText("Running: 24s · Allowed: 18–30s")).toBeInTheDocument();
});
it("keeps join passwords out of review text", async () => {
  show();
  await screen.findByRole("button", { name: "Joining" });
  fireEvent.click(screen.getByRole("button", { name: "Joining" }));
  fireEvent.change(screen.getByPlaceholderText("Leave unchanged"), { target: { value: "test-password-not-real" } });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  expect(screen.getByRole("dialog")).not.toHaveTextContent("test-password-not-real");
  expect(screen.getByRole("dialog")).toHaveTextContent("Password updated");
});
it("queues a map independently of ending the current match", async () => {
  show();
  await screen.findByRole("button", { name: "Rotation" });
  fireEvent.click(screen.getByRole("button", { name: "Rotation" }));
  fireEvent.change(await screen.findByRole("combobox", { name: "Map" }), { target: { value: "Europe" } });
  await screen.findByRole("checkbox", { name: "KOTH_InfantryOnly" });
  fireEvent.click(screen.getByRole("button", { name: "Queue next map" }));
  const dialog = screen.getByRole("dialog");
  expect(screen.queryByRole("textbox", { name: "Reason" })).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Queue next map" }));
  await waitFor(() => expect(request.mock.calls.some(([path]) => path === "actions")).toBe(true));
  expect(JSON.parse(String(request.mock.calls.find(([path]) => path === "actions")![1]?.body))).toMatchObject({
    action: "map-next",
    currentMap: "Kavkazi",
    currentIndex: 0,
    entry: { map: "Europe" },
  });
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
it("preserves a rotation draft across setting groups and edits the original position", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Rotation" }));
  await screen.findByRole("combobox", { name: "Map" });
  fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
  expect(screen.getByRole("button", { name: "Remove Europe" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Move Europe up" })).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox", { name: "Lighting" }), { target: { value: "DayClear" } });
  fireEvent.click(screen.getByRole("button", { name: "Update entry" }));
  fireEvent.click(screen.getByRole("button", { name: "Identity" }));
  fireEvent.click(screen.getByRole("button", { name: "Rotation" }));
  fireEvent.click(screen.getByRole("button", { name: "Review rotation" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("1. Kavkazi · DayClear")).toBeInTheDocument();
  expect(within(dialog).getByText("2. Europe · KOTH_InfantryOnly")).toBeInTheDocument();
  expect(request.mock.calls.some(([path]) => path === "actions")).toBe(false);
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
  fireEvent.click(await screen.findByRole("button", { name: "Gameplay" }));
  const slider = screen.getByRole("slider", { name: "Scoring interval slider" });
  const number = screen.getByRole("spinbutton", { name: "Scoring interval (seconds)" });
  fireEvent.change(slider, { target: { value: "25" } });
  expect(number).toHaveValue(25);
  expect(slider).toHaveAttribute("aria-valuetext", "25 seconds");
  fireEvent.change(number, { target: { value: "26" } });
  expect(slider).toHaveValue("26");
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("24s → 26s · Next match");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.change(number, { target: { value: "24" } });
  expect(screen.queryByRole("button", { name: "Review changes" })).not.toBeInTheDocument();
  expect(request.mock.calls.some(([path]) => path === "actions")).toBe(false);
});
it("rejects exact scoring values outside the server's range", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Gameplay" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: /Scoring interval/ }), { target: { value: "31" } });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  expect(screen.getByRole("alert")).toHaveTextContent("18 to 30 seconds");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("clearing a replacement leaves the password unchanged; removing it is explicit", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Joining" }));
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
it("opens the rotation shortcut and does not save a cancelled or reversed edit", async () => {
  show("admin", "/settings?server=primary#rotation");
  await screen.findByRole("combobox", { name: "Map" });
  expect(screen.getByRole("button", { name: "Rotation" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
  expect(screen.getByRole("button", { name: "Queue next map" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel entry edit" }));
  expect(screen.queryByRole("button", { name: "Review rotation" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Move Europe up" }));
  expect(screen.getByRole("button", { name: "Review rotation" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Move Europe down" }));
  expect(screen.queryByRole("button", { name: "Review rotation" })).not.toBeInTheDocument();
});
