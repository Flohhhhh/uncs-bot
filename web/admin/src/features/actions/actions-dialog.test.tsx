import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { alice, context } from "../players/test-fixtures";
import { ActionsDialog } from "./actions-dialog";

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
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Requested access" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm action" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({ steamId });
  });
  it("requires the exact target confirmation and sends only once", async () => {
    request.mockResolvedValue({ state: "applied", message: "Ban saved" });
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="ban" steamId={alice.steamId} onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Reviewed conduct" } });
    const confirm = screen.getByPlaceholderText(alice.steamId);
    fireEvent.change(confirm, { target: { value: "76561198000000002" } });
    const form = screen.getByRole("button", { name: "Confirm action" }).closest("form")!;
    fireEvent.submit(form);
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("match exactly");
    fireEvent.change(confirm, { target: { value: alice.steamId } });
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
    fireEvent.click(screen.getByRole("button", { name: "Confirm action" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Unconfirmed"));
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(screen.getByRole("status")).toHaveTextContent(body.id);
    expect(screen.queryByRole("button", { name: /Confirm|resubmit/i })).not.toBeInTheDocument();
    expect(admin.invalidateOverview).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(1);
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
    fireEvent.submit(screen.getByRole("button", { name: "Confirm action" }).closest("form")!);
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
        : { state: "accepted", message: "Travel requested" },
    );
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="map" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    await screen.findByRole("option", { name: "Harbor" });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Community map change" } });
    fireEvent.change(screen.getByPlaceholderText("CHANGE MAP"), { target: { value: "CHANGE MAP" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm action" }));
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
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Community notice" } });
    fireEvent.change(screen.getByRole("textbox", { name: /In-game message/ }), {
      target: { value: "First line\nSecond line" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Confirm action" }).closest("form")!);
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
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Community map change" } });
    fireEvent.change(screen.getByPlaceholderText("CHANGE MAP"), { target: { value: "CHANGE MAP" } });
    expect(screen.getByRole("button", { name: "Confirm action" })).toBeEnabled();
    let reject!: (error: Error) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    rerender(tree(1));
    expect(screen.getByRole("button", { name: "Confirm action" })).toBeDisabled();
    reject(new Error("Server options unavailable"));
    await screen.findByText("The server options could not be loaded. Close this review and try again.");
    fireEvent.submit(screen.getByRole("button", { name: "Confirm action" }).closest("form")!);
    expect(request.mock.calls.every(([path]) => path === "catalog")).toBe(true);
  });
});
