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
    nextIndex: 1,
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
function chooseEventServer() {
  fireEvent.click(screen.getByRole("combobox", { name: "Game server" }));
  fireEvent.click(screen.getByRole("option", { name: /^Event server / }));
}

function mount(path = "/settings") {
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.endsWith("/me")
            ? { id: "staff", name: "Staff", role: "admin", csrf: "csrf" }
            : url.endsWith("/servers")
              ? {
                  legacy: true,
                  servers: [
                    { id: "primary", name: "Primary server", version: "0".repeat(64), role: "admin" },
                    { id: "event", name: "Event server", version: "1".repeat(64), role: "admin" },
                  ],
                }
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
    initialEntries: ["/overview", path],
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
  fireEvent.click(screen.getByRole("link", { name: /Server activity/ }));
  expect(await screen.findByRole("dialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/settings");
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("textbox", { name: /Server name/ })).toHaveValue("Event night");
  expect(unload()).toBe(true);
  fireEvent.click(screen.getByRole("link", { name: /Server activity/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/activity"));
  expect(unload()).toBe(false);
  expect(actionCalls(fetcher)).toHaveLength(0);
});

it("switches Match & maps views with a rotation draft and still guards leaving the page", async () => {
  const { router, fetcher } = mount("/match?view=rotation");
  // Europe is shown as Ozeti.
  fireEvent.click(await screen.findByRole("button", { name: "Move Ozeti up" }));
  expect(unload()).toBe(true);
  fireEvent.click(screen.getByRole("tab", { name: "Next round" }));
  await waitFor(() => expect(router.state.location.search).toBe("?view=next"));
  expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Rotation" }));
  const queue = screen.getByRole("list", { name: "Rotation queue" });
  expect(within(queue).getAllByRole("listitem")[0]).toHaveTextContent("Ozeti");
  expect(unload()).toBe(true);
  fireEvent.click(screen.getByRole("link", { name: /Server activity/ }));
  expect(await screen.findByRole("dialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/match");
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(actionCalls(fetcher)).toHaveLength(0);
});

it("guards a server switch on the same page and remounts only after discarding the draft", async () => {
  const { router, fetcher } = mount();
  await editName();
  chooseEventServer();
  expect(await screen.findByRole("dialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();
  expect(router.state.location.search).toBe("");
  expect(fetcher.mock.calls.some(([url]) => url.includes("/servers/event/"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("textbox", { name: /Server name/ })).toHaveValue("Event night");
  chooseEventServer();
  fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
  await waitFor(() => expect(router.state.location.search).toBe("?server=event"));
  expect(await screen.findByRole("textbox", { name: /Server name/ })).toHaveValue("The UNCs");
  expect(actionCalls(fetcher)).toHaveLength(0);
});

it("keeps settings open when a draft navigation from More is cancelled", async () => {
  const { router } = mount();
  await editName();
  const more = screen.getByRole("button", { name: "More sections" });
  expect(more).toHaveClass("active");
  fireEvent.click(more);
  fireEvent.click(within(screen.getByRole("dialog", { name: "More" })).getByRole("link", { name: /Bans/ }));
  expect(await screen.findByRole("dialog", { name: "Discard unsaved changes?" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(router.state.location.pathname).toBe("/settings");
  expect(screen.getByRole("link", { name: /Settings/ })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("textbox", { name: /Server name/ })).toHaveValue("Event night");
});

it("blocks Back/Forward to a different server while a review is open", async () => {
  const { router } = mount();
  await editName();
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  expect(await screen.findByRole("dialog", { name: "Save settings" })).toHaveTextContent("Primary server");
  expect(screen.getByRole("combobox", { name: "Game server" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "More sections" })).toBeDisabled();
  expect(screen.getByRole("button", { name: /^Account:/ })).toBeDisabled();
  await act(async () => {
    await router.navigate("/settings?server=event");
  });
  expect(router.state.location.search).toBe("");
  expect(screen.getByRole("dialog", { name: "Save settings" })).toHaveTextContent("Primary server");
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
  const review = screen.getByRole("dialog", { name: "Save settings" });
  expect(screen.queryByRole("textbox", { name: "Reason" })).not.toBeInTheDocument();
  fireEvent.click(within(review).getByRole("button", { name: "Save settings" }));
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

const signOutFrom = {
  "the account menu": () => {
    fireEvent.click(screen.getByRole("button", { name: /^Account:/ }));
    return screen.getByRole("button", { name: "Sign out" });
  },
  More: () => {
    fireEvent.click(screen.getByRole("button", { name: "More sections" }));
    return within(screen.getByRole("dialog", { name: "More" })).getByRole("button", { name: "Sign out" });
  },
};
it.each(Object.keys(signOutFrom) as (keyof typeof signOutFrom)[])(
  "asks before voluntary sign-out from %s but never sends the draft to the game",
  async (entry) => {
    const { fetcher } = mount();
    await editName();
    fireEvent.click(signOutFrom[entry]());
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/logout"))).toBe(false);
    expect(screen.getByRole("textbox", { name: /Server name/ })).toHaveValue("Event night");
    fireEvent.click(signOutFrom[entry]());
    fireEvent.click(await screen.findByRole("button", { name: "Discard and sign out" }));
    await screen.findByRole("link", { name: /Continue with Discord/ });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/logout"))).toHaveLength(1);
    expect(actionCalls(fetcher)).toHaveLength(0);
    await waitFor(() => expect(unload()).toBe(false));
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
  await waitFor(() => expect(unload()).toBe(false));
});
