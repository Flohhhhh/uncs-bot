import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { alice, bob, context, overview } from "../players/test-fixtures";
import { ActionsDialog } from "./actions-dialog";
import { actionSchema } from "../../../../../src/admin/admin.types";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
beforeEach(() => {
  request.mockReset();
});

describe("server action review", () => {
  it.each([
    ["match-restart", "Restart current match", "RESTART MATCH"],
    ["match-end", "End current match", "END MATCH"],
  ] as const)(
    "requires explicit confirmation before %s can affect the running match",
    async (action, label, phrase) => {
      request.mockResolvedValue({ state: "accepted", message: "Game acknowledged the request." });
      const close = vi.fn();
      render(
        <AdminContext.Provider value={context()}>
          <ActionsDialog action={action} onClose={close} />
        </AdminContext.Provider>,
      );
      expect(screen.getByRole("note", { name: "Live match warning" })).toHaveTextContent(
        "Affects everyone · 3 players connected",
      );
      const send = screen.getByRole("button", { name: label });
      expect(send).toHaveClass("danger");
      expect(send).toBeDisabled();
      fireEvent.submit(send.closest("form")!);
      fireEvent.change(screen.getByPlaceholderText(phrase), { target: { value: "CONFIRM" } });
      fireEvent.submit(send.closest("form")!);
      expect(send).toBeDisabled();
      expect(request).not.toHaveBeenCalled();
      fireEvent.change(screen.getByPlaceholderText(phrase), { target: { value: phrase } });
      expect(send).toBeEnabled();
      fireEvent.click(send);
      fireEvent.submit(send.closest("form")!);
      await screen.findByText("Game acknowledged the request.");
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({ action, confirm: phrase });
      expect(close).not.toHaveBeenCalled();
    },
  );
  it("requires a fresh disruptive-action confirmation after returning from a definite rejection", async () => {
    request.mockResolvedValue({ state: "failed", message: "The game refused the restart." });
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="match-restart" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    fireEvent.change(screen.getByPlaceholderText("RESTART MATCH"), { target: { value: "RESTART MATCH" } });
    fireEvent.click(screen.getByRole("button", { name: "Restart current match" }));
    await screen.findByText("The game refused the restart.");
    fireEvent.click(screen.getByRole("button", { name: "Back to edits" }));
    expect(screen.getByPlaceholderText("RESTART MATCH")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Restart current match" })).toBeDisabled();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("retains the reviewed round across refreshes and captures a new round only after a rejected attempt", async () => {
    request.mockResolvedValue({ state: "failed", message: "The round changed. Nothing was sent." });
    const first = overview();
    const later = { ...first, status: { ...first.status, map: "Europe", matchSeconds: 1 } };
    const tree = (value: typeof first) => (
      <AdminContext.Provider value={context({ overview: value })}>
        <ActionsDialog action="match-restart" onClose={vi.fn()} />
      </AdminContext.Provider>
    );
    const { rerender } = render(tree(first));
    fireEvent.change(screen.getByPlaceholderText("RESTART MATCH"), { target: { value: "RESTART MATCH" } });
    rerender(tree(later));
    expect(screen.getByRole("note", { name: "Live match warning" })).toHaveTextContent("Reviewed match: Harbor");
    fireEvent.click(screen.getByRole("button", { name: "Restart current match" }));
    await screen.findByText("The round changed. Nothing was sent.");
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).expectedRound).toEqual({
      map: "Harbor",
      startedAt: Date.parse(first.observedAt) - 120_000,
    });
    fireEvent.click(screen.getByRole("button", { name: "Back to edits" }));
    expect(screen.getByRole("note", { name: "Live match warning" })).toHaveTextContent("Reviewed match: Ozeti");
    expect(screen.getByRole("button", { name: "Restart current match" })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("RESTART MATCH"), { target: { value: "RESTART MATCH" } });
    fireEvent.click(screen.getByRole("button", { name: "Restart current match" }));
    await screen.findByText("The round changed. Nothing was sent.");
    expect(JSON.parse(String(request.mock.calls[1][1]?.body)).expectedRound).toEqual({
      map: "Europe",
      startedAt: Date.parse(first.observedAt) - 1_000,
    });
  });
  it.each(["match-end", "match-restart", "map"] as const)(
    "blocks %s when the reviewed match clock is unavailable",
    (action) => {
      const current = overview();
      current.status.matchSeconds = undefined;
      request.mockImplementation(() => new Promise(() => {}));
      render(
        <AdminContext.Provider value={context({ overview: current })}>
          <ActionsDialog action={action} onClose={vi.fn()} />
        </AdminContext.Provider>,
      );
      const phrase = action === "match-end" ? "END MATCH" : action === "match-restart" ? "RESTART MATCH" : "CHANGE MAP";
      const input = screen.getByPlaceholderText(phrase);
      fireEvent.change(input, { target: { value: phrase } });
      expect(screen.getByRole("note", { name: "Live match warning" })).toHaveTextContent("match clock is unavailable");
      expect(input.closest("form")!.querySelector("button[type=submit]")).toBeDisabled();
      fireEvent.submit(input.closest("form")!);
      expect(request.mock.calls.some(([path]) => path === "actions")).toBe(false);
    },
  );
  it.each(["receipt", "http"])(
    "preserves entries after a definite %s rejection and records a reviewed retry separately",
    async (kind) => {
      const failure = { state: "failed", message: "The whitelist is locked by the host." };
      if (kind === "receipt") request.mockResolvedValueOnce(failure);
      else request.mockRejectedValueOnce(Object.assign(new Error(failure.message), { status: 422 }));
      request.mockResolvedValueOnce({ state: "applied", message: "Whitelist saved" });
      render(
        <AdminContext.Provider value={context()}>
          <ActionsDialog action="whitelist-add" onClose={vi.fn()} />
        </AdminContext.Provider>,
      );
      fireEvent.change(screen.getByLabelText("SteamID64"), { target: { value: alice.steamId } });
      fireEvent.click(screen.getByRole("button", { name: "Add whitelist access" }));
      await screen.findByText(failure.message);
      expect(screen.getByRole("status", { name: "Action result" })).not.toHaveTextContent(/Check Action history/);
      expect(screen.queryByRole("textbox", { name: "SteamID64" })).not.toBeInTheDocument();
      expect(request).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "Back to edits" }));
      expect(screen.getByLabelText("SteamID64")).toHaveValue(alice.steamId);
      expect(screen.getByLabelText("SteamID64")).toHaveFocus();
      expect(request).toHaveBeenCalledTimes(1);
      fireEvent.change(screen.getByLabelText("SteamID64"), { target: { value: bob.steamId } });
      fireEvent.click(screen.getByRole("button", { name: "Add whitelist access" }));
      await screen.findByText("Whitelist saved");
      const [first, second] = request.mock.calls.map(([, options]) => JSON.parse(String(options?.body)));
      expect(first.steamId).toBe(alice.steamId);
      expect(second.steamId).toBe(bob.steamId);
      expect(second.id).not.toBe(first.id);
    },
  );
  it.each(["accepted", "pending", "unknown"])("offers no resend for a %s result", async (state) => {
    request.mockResolvedValue({ state, message: "Check Action history before repeating this action." });
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="whitelist-add" steamId={alice.steamId} onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add whitelist access" }));
    await screen.findByRole("status", { name: "Action result" });
    expect(
      screen.getByRole("status", { name: "Action result" }).textContent!.match(/Check Action history/g),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Back to edits" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add whitelist access" })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });
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
    await waitFor(() => expect(screen.getByRole("status", { name: "Action result" })).toHaveTextContent("Ban saved"));
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
    await waitFor(() => expect(screen.getByRole("status", { name: "Action result" })).toHaveTextContent("Unconfirmed"));
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(screen.getByRole("status", { name: "Action result" })).toHaveTextContent(body.id);
    expect(screen.queryByRole("button", { name: "Back to edits" })).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Change map" })).toBeDisabled();
    expect(screen.queryByLabelText("Reason")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("CHANGE MAP"), { target: { value: "CHANGE MAP" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Change map" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Change map" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Action result" })).toHaveTextContent("Accepted · not verified"),
    );
    const call = request.mock.calls.find(([path]) => path === "actions")!;
    const body = JSON.parse(String(call[1]?.body));
    expect(body).toMatchObject({ action: "map", map: "Harbor", confirm: "CHANGE MAP" });
    expect(actionSchema.safeParse(body).success).toBe(true);
    expect(body.expectedRound).toEqual({ map: "Harbor", startedAt: Date.parse(overview().observedAt) - 120_000 });
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
  it("does not send a map change before its modes and layouts have loaded successfully", async () => {
    let reject!: (error: Error) => void;
    request.mockImplementation(async (path) => {
      if (path === "catalog") return { maps: [{ id: "Harbor" }], experiences: [], lightings: [] };
      return new Promise((_resolve, fail) => {
        reject = fail;
      });
    });
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="map" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    fireEvent.change(await screen.findByRole("combobox", { name: "Map" }), { target: { value: "Harbor" } });
    fireEvent.change(screen.getByPlaceholderText("CHANGE MAP"), { target: { value: "CHANGE MAP" } });
    const send = screen.getByRole("button", { name: "Change map" });
    expect(send).toBeDisabled();
    fireEvent.submit(send.closest("form")!);
    reject(new Error("Map options unavailable"));
    await screen.findByText("Map options unavailable");
    expect(send).toBeDisabled();
    fireEvent.submit(send.closest("form")!);
    expect(request.mock.calls.every(([path]) => path.startsWith("catalog"))).toBe(true);
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Change map" })).toBeEnabled());
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
