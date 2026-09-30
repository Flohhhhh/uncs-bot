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
});
