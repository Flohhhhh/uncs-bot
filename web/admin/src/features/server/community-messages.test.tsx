import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext, type AdminContextValue } from "../../app/context";
import { context } from "../players/test-fixtures";
import { CommunityMessages } from "./community-messages";
import { AnnouncementsPage } from "./pages";
import type { CommunityMessagesStatus } from "../../../../../src/common/community-messages";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const configured: CommunityMessagesStatus = {
  enabled: true,
  workerStarted: true,
  lastObservedAt: null,
  lastMessageAcknowledgedAt: null,
  lastStatusCardUpdatedAt: null,
  welcome: {
    enabled: true,
    messages: ["Welcome to The UNCs", "Apply for a free whitelist on our website"],
    delaySeconds: 10,
    spacingSeconds: 20,
  },
  round: { enabled: false, message: "GG everyone" },
  discordStatus: { enabled: true, configured: false },
};
function page(id = "primary", refreshVersion = 0, children: ReactNode = <CommunityMessages key={id} />) {
  return (
    <MemoryRouter initialEntries={[`/announcements?server=${id}`]}>
      <AdminContext.Provider
        value={{ ...context({ refreshVersion }), server: { id, name: id, version: "1".repeat(64), role: "admin" } }}
      >
        {children}
      </AdminContext.Provider>
    </MemoryRouter>
  );
}
/** The status shown on one message row. */
function status(name: string) {
  const row = screen.getByText(name, { selector: ".message-name" }).parentElement!;
  return row.querySelector(".pill")?.textContent;
}
beforeEach(() => {
  request.mockReset();
});

it("shows configured welcome timing and a missing Discord target without claiming delivery", async () => {
  request.mockResolvedValue(configured);
  render(page());
  expect(await screen.findByText("Needs channel and message")).toBeInTheDocument();
  expect(status("Welcome")).toBe("On");
  expect(status("Round notice")).toBe("Off");
  expect(screen.getByText("2 messages · 10 s delay")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Welcome", { selector: ".message-name" }));
  expect(screen.getByText(/Sent 10 s after an observed join, at least 20 s apart/)).toBeVisible();
  expect(screen.getByText("Apply for a free whitelist on our website")).toBeVisible();
  fireEvent.click(screen.getByText("Activity & setup"));
  expect(screen.getByText(/does not prove a player saw it/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "View message receipts →" })).toHaveAttribute(
    "href",
    "/activity?server=primary&view=actions",
  );
  // Status refreshes with the dashboard; there is no separate refresh button.
  expect(screen.queryByRole("button", { name: /Refresh|Retry/ })).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledWith(
    "servers/primary/community-messages",
    expect.objectContaining({ signal: expect.anything() }),
  );
});

it("does not show an on or off state before the first response", async () => {
  let resolve!: (data: CommunityMessagesStatus) => void;
  request.mockReturnValue(
    new Promise<CommunityMessagesStatus>((done) => {
      resolve = done;
    }),
  );
  render(page());
  expect(screen.getByText("Loading message status…")).toBeInTheDocument();
  expect(screen.queryByText("Off")).not.toBeInTheDocument();
  expect(screen.queryByText("On")).not.toBeInTheDocument();
  await act(async () =>
    resolve({
      ...configured,
      enabled: false,
      workerStarted: false,
      welcome: { ...configured.welcome, enabled: false },
      discordStatus: { enabled: false, configured: false },
    }),
  );
  expect(screen.getAllByText("Off")).toHaveLength(3);
  expect(screen.queryByText("On")).not.toBeInTheDocument();
  expect(screen.getByText("Turned off for this deployment.")).toBeInTheDocument();
});

it("stops displaying old activation states when refresh fails and permits retry", async () => {
  request
    .mockResolvedValueOnce(configured)
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValueOnce(configured);
  const view = render(page());
  await screen.findByText("Needs channel and message");
  view.rerender(page("primary", 1));
  await screen.findByText("Message status could not be loaded");
  expect(screen.getByRole("alert")).toHaveTextContent("Message status could not be loaded");
  expect(screen.queryByText("On")).not.toBeInTheDocument();
  expect(screen.queryByText("Needs channel and message")).not.toBeInTheDocument();
  expect(screen.getByText(/No activation state has been assumed/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Needs channel and message");
  expect(request).toHaveBeenCalledTimes(3);
});

it("clears the prior server's configuration immediately when selecting another server", async () => {
  request.mockResolvedValueOnce(configured).mockReturnValueOnce(new Promise(() => {}));
  const view = render(page());
  await screen.findByText("Needs channel and message");
  view.rerender(page("event"));
  await waitFor(() => expect(request).toHaveBeenCalledWith("servers/event/community-messages", expect.anything()));
  expect(screen.getByText("Loading message status…")).toBeInTheDocument();
  expect(screen.queryByText("Needs channel and message")).not.toBeInTheDocument();
  // In the real dashboard a server switch remounts the entire page; the hook also aborts its old request.
  expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

function composer(admin: Partial<AdminContextValue> = {}) {
  const state = { ...context(), ...admin };
  request.mockResolvedValue(configured);
  render(
    <MemoryRouter initialEntries={["/announcements"]}>
      <AdminContext.Provider value={state}>
        <AnnouncementsPage />
      </AdminContext.Provider>
    </MemoryRouter>,
  );
  return state;
}

it("drafts an announcement on the page and opens the existing review with it", async () => {
  const admin = composer();
  const message = screen.getByRole("textbox", { name: "Message" });
  const send = screen.getByRole("button", { name: "Send to 3 players" });
  expect(send).toBeDisabled();
  expect(screen.getByText("0 / 200")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Use template" }));
  expect(message).toHaveValue("GG! Get whitelisted at theuncsgaming.com/whitelist. Thanks for playing on The UNCs.");
  fireEvent.change(message, { target: { value: "  Event starts\nin five minutes  " } });
  expect(message).toHaveValue("  Event starts in five minutes  ");
  expect(screen.getByText("32 / 200")).toBeInTheDocument();
  fireEvent.click(send);
  // The page never sends: it opens the broadcast review, prefilled.
  expect(admin.openAction).toHaveBeenCalledWith("broadcast", undefined, {
    initialMessage: "Event starts in five minutes",
  });
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  await screen.findByText("Needs channel and message");
});

it("keeps the composer's send button disabled while the server needs a fresh check", async () => {
  composer({ stale: true });
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Hello" } });
  expect(screen.getByRole("button", { name: "Send to 3 players" })).toBeDisabled();
  await screen.findByText("Needs channel and message");
  // Three compact rows: welcome, round notice and the Discord card.
  expect(screen.getByRole("list", { name: "Automatic messages" }).querySelectorAll(":scope > li")).toHaveLength(3);
});
