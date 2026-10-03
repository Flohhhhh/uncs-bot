import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context } from "../players/test-fixtures";
import { CommunityMessages } from "./community-messages";
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
function page(id = "primary") {
  return (
    <MemoryRouter initialEntries={[`/announcements?server=${id}`]}>
      <AdminContext.Provider value={{ ...context(), server: { id, name: id, version: "1".repeat(64), role: "admin" } }}>
        <CommunityMessages key={id} />
      </AdminContext.Provider>
    </MemoryRouter>
  );
}
beforeEach(() => request.mockReset());

it("shows configured welcome timing and a missing Discord target without claiming delivery", async () => {
  request.mockResolvedValue(configured);
  render(page());
  expect(await screen.findByText("Needs channel and message")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Welcome sequence · 2 messages"));
  expect(screen.getByText(/Starts 10s after an observed join.*20s between messages/)).toBeInTheDocument();
  expect(screen.getByText("Apply for a free whitelist on our website")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Activity & setup"));
  expect(screen.getByText(/does not prove a player saw it/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "View message receipts →" })).toHaveAttribute(
    "href",
    "/audit?server=primary",
  );
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
  expect(screen.queryByText("OFF")).not.toBeInTheDocument();
  await act(async () =>
    resolve({
      ...configured,
      enabled: false,
      workerStarted: false,
      welcome: { ...configured.welcome, enabled: false },
      discordStatus: { enabled: false, configured: false },
    }),
  );
  expect(screen.getByText("OFF")).toBeInTheDocument();
  expect(screen.queryByText("Enabled")).not.toBeInTheDocument();
});

it("stops displaying old activation states when refresh fails and permits retry", async () => {
  request
    .mockResolvedValueOnce(configured)
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValueOnce(configured);
  render(page());
  await screen.findByText("Needs channel and message");
  fireEvent.click(screen.getByRole("button", { name: "Refresh message status" }));
  await screen.findByText("STATUS UNAVAILABLE");
  expect(screen.getByRole("alert")).toHaveTextContent("Message status could not be loaded");
  expect(screen.queryByText("Enabled")).not.toBeInTheDocument();
  expect(screen.getByText(/No activation state has been assumed/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh message status" }));
  await screen.findByText("Needs channel and message");
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
