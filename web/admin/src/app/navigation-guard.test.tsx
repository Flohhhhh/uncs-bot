import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./app";
import { settingFields, type SettingsSnapshot } from "../../../../src/common/server-settings";

const snapshot: SettingsSnapshot = {
  revision: "initial",
  writable: true,
  notice: "",
  scoreTick: { current: 24, min: 18, max: 30 },
  fields: settingFields.map((field) => ({
    id: field.id,
    value: field.id === "serverName" ? "The UNCs" : field.secret ? null : "",
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
      { map: "Europe", experiences: [] },
    ],
  },
};
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.endsWith("/me")
            ? { id: "staff", name: "Staff", role: "admin", csrf: "csrf" }
            : url.endsWith("/settings")
              ? snapshot
              : url.endsWith("/catalog")
                ? { maps: [{ id: "Europe" }, { id: "Kavkazi" }], experiences: [], lightings: [] }
                : url.endsWith("/overview")
                  ? {
                      observedAt: new Date().toISOString(),
                      status: {
                        serverName: "Test server",
                        map: "Europe",
                        players: { current: 0, max: 100 },
                        factionScores: [],
                      },
                      players: [],
                      capabilities: { routes: [] },
                    }
                  : url.endsWith("/actions")
                    ? { state: "pending", message: "Saved for next match." }
                    : [],
        ),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const router = createMemoryRouter([{ path: "/*", element: <App /> }], {
    initialEntries: ["/overview", "/settings"],
    initialIndex: 1,
  });
  render(<RouterProvider router={router} />);
  return { router, fetcher };
}
async function editName() {
  fireEvent.change(await screen.findByRole("textbox", { name: /Server name/ }), { target: { value: "Event night" } });
}
function unload() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
function actionCalls(fetcher: ReturnType<typeof mount>["fetcher"]) {
  return fetcher.mock.calls.filter(([url]) => url.endsWith("/actions"));
}

it("keeps a settings draft when leaving is cancelled, then discards only after confirmation", async () => {
  const { router, fetcher } = mount();
  await editName();
  expect(unload()).toBe(true);
  fireEvent.click(screen.getByRole("link", { name: /Action history/ }));
  expect(await screen.findByRole("dialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/settings");
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("textbox", { name: /Server name/ })).toHaveValue("Event night");
  expect(unload()).toBe(true);
  fireEvent.click(screen.getByRole("link", { name: /Action history/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/audit"));
  expect(unload()).toBe(false);
  expect(actionCalls(fetcher)).toHaveLength(0);
});

it("guards browser Back and keeps editing when Escape dismisses the warning", async () => {
  const { router } = mount();
  await editName();
  await act(async () => {
    await router.navigate(-1);
  });
  const dialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
  fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
  expect(router.state.location.pathname).toBe("/settings");
  expect(screen.getByRole("textbox", { name: /Server name/ })).toHaveValue("Event night");
  await act(async () => {
    await router.navigate(-1);
  });
  fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/overview"));
});

it("retains hidden rotation drafts and does not clear their warning when a settings draft is discarded", async () => {
  const { router } = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Rotation" }));
  fireEvent.click(screen.getByRole("button", { name: "Move Europe up" }));
  fireEvent.click(screen.getByRole("button", { name: "Identity" }));
  await editName();
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  fireEvent.click(screen.getByRole("link", { name: /Action history/ }));
  expect(await screen.findByRole("dialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  fireEvent.click(screen.getByRole("button", { name: "Rotation" }));
  expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Europe");
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  expect(unload()).toBe(false);
  fireEvent.click(screen.getByRole("link", { name: /Action history/ }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/audit"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("does not abandon a review or a pending save through browser history", async () => {
  const { router, fetcher } = mount();
  await editName();
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  await act(async () => {
    await router.navigate(-1);
  });
  expect(router.state.location.pathname).toBe("/settings");
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  const original = fetcher.getMockImplementation()!;
  let finish!: (response: Response) => void;
  fetcher.mockImplementation((url) =>
    url.endsWith("/actions")
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : original(url),
  );
  const review = screen.getByRole("dialog", { name: "Review server changes" });
  fireEvent.change(within(review).getByRole("textbox", { name: "Reason" }), { target: { value: "Event setup" } });
  fireEvent.click(within(review).getByRole("button", { name: "Confirm changes" }));
  await act(async () => {
    await router.navigate(-1);
  });
  expect(router.state.location.pathname).toBe("/settings");
  expect(unload()).toBe(true);
  expect(actionCalls(fetcher)).toHaveLength(1);
  await act(async () => {
    finish(new Response(JSON.stringify({ state: "pending", message: "Saved for next match." })));
  });
  await within(review).findByText("Saved for next match.");
  fireEvent.click(within(review).getByRole("button", { name: "Close" }));
  expect(unload()).toBe(false);
  await act(async () => {
    await router.navigate(-1);
  });
  expect(router.state.location.pathname).toBe("/overview");
});

it.each([0, 1])(
  "asks before voluntary sign-out from button %i but never sends the draft to the game",
  async (index) => {
    const { fetcher } = mount();
    await editName();
    fireEvent.click(screen.getAllByRole("button", { name: "Sign out" })[index]);
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/logout"))).toBe(false);
    expect(screen.getByRole("textbox", { name: /Server name/ })).toHaveValue("Event night");
    fireEvent.click(screen.getAllByRole("button", { name: "Sign out" })[index]);
    fireEvent.click(await screen.findByRole("button", { name: "Discard and sign out" }));
    await screen.findByRole("link", { name: /Continue with Discord/ });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/logout"))).toHaveLength(1);
    expect(actionCalls(fetcher)).toHaveLength(0);
    expect(unload()).toBe(false);
  },
);

it("clears staff data immediately on session expiry even with an unsaved draft", async () => {
  const { fetcher } = mount();
  await editName();
  fetcher.mockImplementation(async () => new Response("Expired", { status: 401 }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
  await screen.findByRole("link", { name: /Continue with Discord/ });
  expect(screen.queryByRole("textbox", { name: /Server name/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(unload()).toBe(false);
});
