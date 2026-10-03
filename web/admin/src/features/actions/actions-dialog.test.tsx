import { fireEvent, render as renderTree, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
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
/** Reviews link to Action history, so they render inside a router, as in the app. */
function render(ui: ReactElement, path = "/match?server=primary") {
  return renderTree(ui, {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>,
  });
}
/** Only POSTs to `actions` change the game; an ended-match review also reads the saved rotation. */
const sent = () =>
  request.mock.calls.filter(([path]) => path === "actions").map(([, options]) => JSON.parse(String(options?.body)));

describe("server action review", () => {
  it.each([
    ["match-restart", "Restart current match", "RESTART MATCH", "Restarts Harbor for 3 players."],
    ["match-end", "End current match", "END MATCH", "Ends Harbor for 3 players."],
  ] as const)(
    "reviews %s without typing and sends only after the confirmation button is clicked",
    async (action, label, phrase, impact) => {
      request.mockResolvedValue({ state: "accepted", message: "Game acknowledged the request." });
      const close = vi.fn();
      render(
        <AdminContext.Provider value={context()}>
          <ActionsDialog action={action} onClose={close} />
        </AdminContext.Provider>,
      );
      const warning = screen.getByRole("note", { name: "Live match warning" });
      expect(warning).toHaveTextContent(impact);
      expect(warning).toHaveTextContent("Checked again before sending: still this round of Harbor.");
      const send = screen.getByRole("button", { name: label });
      expect(send).toHaveClass("danger");
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(sent()).toHaveLength(0);
      expect(send).toBeEnabled();
      fireEvent.click(send);
      fireEvent.submit(send.closest("form")!);
      await screen.findByText("Game acknowledged the request.");
      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toMatchObject({ action, confirm: phrase });
      expect(close).not.toHaveBeenCalled();
    },
  );
  it.each([
    [
      "names the saved next round",
      { enabled: true, mode: "Ordered", currentIndex: 0, nextIndex: 1, currentMap: "Harbor" },
      "Next: Ozeti · King of the Hill (saved rotation).",
    ],
    [
      "does not guess the next round when the rotation is off",
      { enabled: false, mode: "Ordered", currentIndex: 0, nextIndex: 1, currentMap: "Harbor" },
      "No fixed next map: rotation is off.",
    ],
    [
      "does not guess the next round when the running entry is unknown",
      { enabled: true, mode: "Ordered", currentIndex: 1, nextIndex: null, currentMap: "Harbor" },
      "Next map not confirmed.",
    ],
  ])("%s before ending a match", async (_name, rotation, line) => {
    request.mockImplementation(async (path) =>
      path === "settings"
        ? {
            revision: "r1",
            fields: [],
            rotation: {
              editable: true,
              note: "",
              entries: [
                { map: "Harbor", experiences: [] },
                { map: "Europe", experiences: ["KOTH"] },
              ],
              ...rotation,
            },
          }
        : new Promise(() => {}),
    );
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="match-end" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    const warning = screen.getByRole("note", { name: "Live match warning" });
    expect(warning).toHaveTextContent("Next: checking the rotation…");
    await waitFor(() => expect(warning).toHaveTextContent(line));
    // Reading the rotation sends nothing and never holds back the review.
    expect(sent()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "End current match" })).toBeEnabled();
  });
  it("still allows ending a match when the saved rotation cannot be read", async () => {
    request.mockImplementation(async (path) => {
      if (path === "settings") throw new Error("Settings unavailable");
      return { state: "accepted", message: "End requested" };
    });
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="match-end" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    const warning = screen.getByRole("note", { name: "Live match warning" });
    await waitFor(() => expect(warning).toHaveTextContent("Next map not confirmed."));
    fireEvent.click(screen.getByRole("button", { name: "End current match" }));
    await screen.findByText("End requested");
    expect(sent()).toHaveLength(1);
  });
  it("requires a fresh disruptive-action confirmation after returning from a definite rejection", async () => {
    request.mockResolvedValue({ state: "failed", message: "The game refused the restart." });
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="match-restart" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Restart current match" }));
    await screen.findByText("The game refused the restart.");
    fireEvent.click(screen.getByRole("button", { name: "Back to edits" }));
    expect(screen.getByRole("button", { name: "Restart current match" })).toBeEnabled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
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
    rerender(tree(later));
    expect(screen.getByRole("note", { name: "Live match warning" })).toHaveTextContent(
      "Restarts Harbor for 3 players.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Restart current match" }));
    await screen.findByText("The round changed. Nothing was sent.");
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).expectedRound).toEqual({
      map: "Harbor",
      startedAt: Date.parse(first.observedAt) - 120_000,
    });
    fireEvent.click(screen.getByRole("button", { name: "Back to edits" }));
    expect(screen.getByRole("note", { name: "Live match warning" })).toHaveTextContent("Restarts Ozeti for 3 players.");
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Restart current match" }));
    await screen.findByText("The round changed. Nothing was sent.");
    expect(JSON.parse(String(request.mock.calls[1][1]?.body)).expectedRound).toEqual({
      map: "Europe",
      startedAt: Date.parse(first.observedAt) - 1_000,
    });
  });
  it.each(["match-end", "match-restart", "map"] as const)(
    "blocks %s when the reviewed map is unavailable",
    (action) => {
      const current = overview();
      current.status.map = "";
      request.mockImplementation(() => new Promise(() => {}));
      render(
        <AdminContext.Provider value={context({ overview: current })}>
          <ActionsDialog action={action} onClose={vi.fn()} />
        </AdminContext.Provider>,
      );
      const label =
        action === "match-end"
          ? "End current match"
          : action === "match-restart"
            ? "Restart current match"
            : "Change map";
      const submit = screen.getByRole("button", { name: label });
      expect(screen.getByRole("note", { name: "Live match warning" })).toHaveTextContent("current map is unavailable");
      expect(submit).toBeDisabled();
      fireEvent.submit(submit.closest("form")!);
      expect(request.mock.calls.some(([path]) => path === "actions")).toBe(false);
    },
  );
  it("allows an explicitly reviewed map when this game build supplies no round clock", async () => {
    const current = overview();
    current.status.matchSeconds = undefined;
    request.mockResolvedValue({ state: "accepted", message: "Restart requested" });
    render(
      <AdminContext.Provider value={context({ overview: current })}>
        <ActionsDialog action="match-restart" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    expect(screen.getByRole("note", { name: "Live match warning" })).toHaveTextContent(
      "Checked again before sending: still Harbor. A new round on the same map can't be detected.",
    );
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restart current match" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Restart current match" }));
    await screen.findByText("Restart requested");
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).expectedRound).toEqual({
      map: "Harbor",
      startedAt: null,
    });
  });
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
    expect(screen.getByRole("dialog", { name: "Add whitelist access" })).toHaveTextContent("STAFF REVIEW");
    fireEvent.click(screen.getByRole("button", { name: "Add whitelist access" }));
    await screen.findByRole("status", { name: "Action result" });
    // The result screen is no longer a review.
    expect(screen.queryByText("STAFF REVIEW")).not.toBeInTheDocument();
    const outcome = screen.getByRole("status", { name: "Action result" });
    expect(outcome.textContent!.match(/Check Action history/g)).toHaveLength(1);
    expect(
      within(outcome).getByText(
        state === "accepted" ? "Accepted · not verified" : state === "pending" ? "Pending" : "Unconfirmed",
      ),
    ).toHaveClass("pill", "warn");
    const id = sent()[0].id;
    expect(within(outcome).getByRole("link", { name: "Open this action in Action history" })).toHaveAttribute(
      "href",
      `/activity?server=primary&view=actions&id=${id}`,
    );
    expect(screen.queryByRole("button", { name: "Back to edits" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add whitelist access" })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("links an unconfirmed result to its receipt and closes the review before leaving", async () => {
    request.mockResolvedValue({ state: "unknown", message: "The game did not answer." });
    const close = vi.fn();
    const navigate = vi.fn();
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="broadcast" initialMessage="Welcome" onClose={close} onNavigate={navigate} />
      </AdminContext.Provider>,
      "/overview",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send announcement" }));
    const outcome = await screen.findByRole("status", { name: "Action result" });
    expect(outcome).toHaveTextContent("Check Action history for confirmation before repeating this action.");
    const id = sent()[0].id;
    const link = within(outcome).getByRole("link", { name: "Action history" });
    // Without a server in the address, the link adds none.
    expect(link).toHaveAttribute("href", `/activity?view=actions&id=${id}`);
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith({ pathname: "/activity", search: `?view=actions&id=${id}` });
    expect(sent()).toHaveLength(1);
  });
  it.each([
    ["applied", "Applied", "good", "success"],
    ["failed", "Failed", "bad", "error"],
  ] as const)("shows a %s result with the shared outcome label", async (state, label, kind, notice) => {
    request.mockResolvedValue({ state, message: "Recorded." });
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="broadcast" initialMessage="Welcome" onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send announcement" }));
    const outcome = await screen.findByRole("status", { name: "Action result" });
    expect(outcome).toHaveClass("notice", notice);
    expect(within(outcome).getByText(label)).toHaveClass("pill", kind);
    expect(within(outcome).queryByRole("link")).not.toBeInTheDocument();
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
    request.mockResolvedValueOnce({ record: { id: body.id, state: "applied", message: "Kick recorded." } });
    fireEvent.click(screen.getByText("Action details"));
    fireEvent.click(screen.getByRole("button", { name: "Check saved result" }));
    expect(await screen.findByRole("status", { name: "Saved action result" })).toHaveTextContent("Kick recorded.");
    expect(request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(request.mock.calls[1][0]).toBe(`audit/${body.id}`);
    expect(screen.queryByRole("button", { name: "Back to edits" })).not.toBeInTheDocument();
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
    await screen.findByRole("option", { name: "Conquest" });
    expect(screen.queryByLabelText("Reason")).not.toBeInTheDocument();
    expect(request.mock.calls.some(([path]) => path === "actions")).toBe(false);
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
  it("prefills a drafted announcement but sends it only from the review", async () => {
    request.mockResolvedValue({ state: "applied", message: "Announcement sent." });
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action="broadcast" initialMessage="GG, thanks for playing." onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    const field = screen.getByRole("textbox", { name: /In-game message/ });
    expect(field).toHaveValue("GG, thanks for playing.");
    expect(field).toHaveAccessibleDescription("23/200");
    expect(request).not.toHaveBeenCalled();
    fireEvent.submit(screen.getByRole("button", { name: "Send announcement" }).closest("form")!);
    await screen.findByText("Announcement sent.");
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({
      action: "broadcast",
      message: "GG, thanks for playing.",
    });
  });
  it.each([
    ["broadcast", "paste", /In-game message/, "Send announcement", "single-line message"],
    ["message", "type", /In-game message/, "Message player", "single-line message"],
    ["kick", "paste", "Reason", "Kick player", "single-line reason"],
  ] as const)("keeps every character of an over-long %s and refuses it before any request", async (...test) => {
    const [action, entry, name, label, refusal] = test;
    const user = userEvent.setup();
    render(
      <AdminContext.Provider value={context()}>
        <ActionsDialog action={action} steamId={action === "broadcast" ? undefined : alice.steamId} onClose={vi.fn()} />
      </AdminContext.Provider>,
    );
    const field = screen.getByRole("textbox", { name });
    expect(field).toHaveAccessibleDescription("0/200");
    const text = `${"Long announcement ".repeat(12)}ends here`.padEnd(230, ".");
    await user.click(field);
    if (entry === "paste") await user.paste(text);
    else await user.type(field, text);
    expect(field).toHaveValue(text);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("230/200 · 30 over the limit");
    await user.click(screen.getByRole("button", { name: label }));
    expect(screen.getByRole("alert")).toHaveTextContent(refusal);
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
