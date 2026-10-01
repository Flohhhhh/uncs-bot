import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { alice, context } from "../players/test-fixtures";
import { ActionsDialog } from "./actions-dialog";
import { actionSchema } from "../../../../../src/admin/admin.types";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
beforeEach(() => {
  request.mockReset();
});

describe("server action review", () => {
  it("accepts a structural SteamID64 beyond the old prefix while preserving its exact string", async () => {
    const steamId = "76561200000000000";
    request.mockResolvedValue({ state: "applied", message: "Whitelist saved" });
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="whitelist-add" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    const field = screen.getByLabelText("SteamID64");
    expect(field).toHaveAttribute("pattern", "[0-9]{17}");
    fireEvent.change(field, { target: { value: steamId } });
    expect(screen.queryByLabelText("Reason")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add whitelist access" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({ steamId });
  });
  it("bans the displayed player without retyping their ID and sends only once", async () => {
    request.mockResolvedValue({ state: "applied", message: "Ban saved" });
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="ban" steamId={alice.steamId} onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Reviewed conduct" } });
    expect(screen.getByText(alice.name)).toBeInTheDocument();
    expect(screen.getByText(alice.steamId)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(alice.steamId)).not.toBeInTheDocument();
    const form = screen.getByRole("button", { name: "Ban player" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ban saved"));
    expect(request).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      action: "ban",
      steamId: alice.steamId,
      confirm: alice.steamId,
      reason: "Reviewed conduct",
    });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(actionSchema.safeParse(body).success).toBe(true);
  });
  it("retains the audit ID and offers no resend after a dropped response", async () => {
    request.mockRejectedValue(new Error("Network dropped"));
    const admin = context();
    render(
      <AdminContext.Provider value={admin}>
        <ActionsDialog action="kick" steamId={alice.steamId} onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Resolve stuck connection" } });
    fireEvent.click(screen.getByRole("button", { name: "Kick player" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Unconfirmed"));
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(screen.getByRole("status")).toHaveTextContent(body.id);
    expect(screen.queryByRole("button", { name: /Confirm|resubmit/i })).not.toBeInTheDocument();
    expect(admin.invalidateOverview).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["message", "Message player"],
    ["broadcast", "Send announcement"],
    ["kill", "Force player respawn"],
  ] as const)("submits %s without an extra reason or ID field", async (action, label) => {
    request.mockResolvedValue({ state: "applied", message: "Recorded" });
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action={action} steamId={action === "broadcast" ? undefined : alice.steamId} onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    expect(screen.queryByLabelText("Reason")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(alice.steamId)).not.toBeInTheDocument();
    if (action !== "kill") {
      fireEvent.change(screen.getByRole("textbox", { name: /In-game message/ }), { target: { value: "Welcome" } });
    }
    fireEvent.click(screen.getByRole("button", { name: label }));
    await screen.findByText("Recorded");
    expect(request).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(actionSchema.safeParse(body).success).toBe(true);
    if (action === "kill") expect(body).toMatchObject({ steamId: alice.steamId, confirm: alice.steamId });
    else expect(body.message).toBe("Welcome");
  });
  it("still requires a moderation reason before banning", () => {
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="ban" steamId={alice.steamId} onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    fireEvent.submit(screen.getByRole("button", { name: "Ban player" }).closest("form")!);
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("reason");
  });
  it("rechecks the role when submitting a dialog opened before a role change", () => {
    const admin = context();
    const tree = (value: typeof admin) => (
      <AdminContext.Provider value={value}>
        <ActionsDialog action="kick" steamId={alice.steamId} onClose={vi.fn()} />
      </AdminContext.Provider>
    );
    const { rerender } = render(tree(admin));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "A reason" } });
    rerender(tree({ ...admin, me: { ...admin.me, role: "viewer" } }));
    fireEvent.submit(screen.getByRole("button", { name: "Kick player" }).closest("form")!);
    expect(request).not.toHaveBeenCalled();
  });
  it("loads real catalog choices and preserves optional map selections", async () => {
    request.mockImplementation(async (path) =>
      path === "catalog"
        ? {
            maps: [{ id: "Harbor", displayName: "Harbor" }],
            experiences: [{ id: "Conquest" }],
            lightings: [{ id: "Day" }],
          }
        : path.startsWith("catalog/maps/")
          ? { experiences: [{ id: "Conquest" }], zones: null }
          : { state: "accepted", message: "Travel requested" },
    );
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="map" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    await screen.findByRole("option", { name: "Harbor" });
    fireEvent.change(screen.getByRole("combobox", { name: "Map" }), { target: { value: "Harbor" } });
    await screen.findByRole("checkbox", { name: "Conquest" });
    expect(screen.queryByLabelText("Reason")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("CHANGE MAP"), { target: { value: "CHANGE MAP" } });
    fireEvent.click(screen.getByRole("button", { name: "Change map" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Accepted · not verified"));
    const call = request.mock.calls.find(([path]) => path === "actions")!;
    const body = JSON.parse(String(call[1]?.body));
    expect(body).toMatchObject({ action: "map", map: "Harbor", confirm: "CHANGE MAP" });
    expect(body).not.toHaveProperty("lighting");
    expect(body).not.toHaveProperty("experiences");
  });
  it("rejects multiline announcements before any request", () => {
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="broadcast" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    expect(screen.queryByLabelText("Reason")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /In-game message/ }), {
      target: { value: "First line\nSecond line" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Send announcement" }).closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent("single-line message");
    expect(request).not.toHaveBeenCalled();
  });
  it("blocks map submissions while retained catalog options are refreshing or failed", async () => {
    request.mockResolvedValueOnce({ maps: [{ id: "Harbor" }], experiences: [], lightings: [] });
    const admin = context();
    const tree = (version: number) => (
      <AdminContext.Provider value={{ ...admin, refreshVersion: version }}>
        <ActionsDialog action="map" onClose={vi.fn()} />
      </AdminContext.Provider>
    );
    const { rerender } = render(tree(0));
    await screen.findByRole("option", { name: "Harbor" });
    request.mockResolvedValueOnce({ experiences: [], zones: null });
    fireEvent.change(screen.getByRole("combobox", { name: "Map" }), { target: { value: "Harbor" } });
    await waitFor(() => expect(request.mock.calls.some(([path]) => path === "catalog/maps/Harbor")).toBe(true));
    expect(screen.queryByLabelText("Reason")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("CHANGE MAP"), { target: { value: "CHANGE MAP" } });
    expect(screen.getByRole("button", { name: "Change map" })).toBeEnabled();
    let reject!: (error: Error) => void;
    request.mockImplementation((path) =>
      path === "catalog"
        ? new Promise((_resolve, fail) => {
            reject = fail;
          })
        : Promise.resolve({ experiences: [], zones: null }),
    );
    rerender(tree(1));
    expect(screen.getByRole("button", { name: "Change map" })).toBeDisabled();
    reject(new Error("Server options unavailable"));
    await screen.findByText("The server options could not be loaded. Close this review and try again.");
    fireEvent.submit(screen.getByRole("button", { name: "Change map" }).closest("form")!);
    expect(request.mock.calls.every(([path]) => path.startsWith("catalog"))).toBe(true);
  });
});
