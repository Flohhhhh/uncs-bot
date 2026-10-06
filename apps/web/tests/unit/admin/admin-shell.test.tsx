import type { ComponentProps, MouseEvent } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/admin/players",
  search: "?server=event&view=actions",
  push: vi.fn(),
  replace: vi.fn(),
  endSession: vi.fn(),
  setTheme: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, ComponentProps<"a">>(({ href, onClick, ...props }, ref) =>
    React.createElement("a", {
      ...props,
      href,
      ref,
      onClick: (event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        onClick?.(event);
      },
    }),
  );
  Link.displayName = "MockNextLink";
  return { default: Link };
});

vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: mocks.setTheme }) }));

vi.mock("~/lib/session/client", () => ({
  endSession: mocks.endSession,
  SessionError: class extends Error {
    status = 401;
  },
}));

import { AdminShell } from "~/components/admin-shell";

const staff = {
  id: "staff-1",
  name: "Alex Operator",
  role: "admin" as const,
  csrf: "csrf-token",
  demo: true,
  gameMode: "sample" as const,
};

const servers = {
  legacy: false,
  servers: [
    { id: "primary", name: "Primary server", version: "1".repeat(64), role: "admin" as const },
    { id: "event", name: "Event server", version: "2".repeat(64), role: "moderator" as const },
  ],
};

let mobileViewport = false;

function renderShell() {
  return render(
    <AdminShell user={staff}>
      <p>Admin page content</p>
    </AdminShell>,
  );
}

beforeEach(() => {
  mocks.pathname = "/admin/players";
  mocks.search = "?server=event&view=actions";
  mocks.push.mockReset();
  mocks.replace.mockReset();
  mocks.endSession.mockReset().mockResolvedValue(undefined);
  mocks.setTheme.mockReset();
  mobileViewport = false;

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: mobileViewport,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  });

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => servers,
      body: { cancel: vi.fn() },
    }),
  );
});

it("collapses to the branded icon rail and keeps active links on the selected server", async () => {
  const user = userEvent.setup();
  renderShell();

  const switcher = await screen.findByRole("button", { name: "Server: Event server" });
  expect(switcher).toHaveTextContent("Event server");
  expect(screen.getByRole("link", { name: "Players" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "Players" })).toHaveAttribute(
    "href",
    "/admin/players?server=event&view=actions",
  );
  expect(screen.getByRole("link", { name: "Players" })).toHaveAttribute("data-active", "true");
  expect(screen.getByText("Live")).toBeInTheDocument();
  expect(screen.getByText("Community")).toBeInTheDocument();
  expect(screen.getByText("Server", { selector: "div" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
  await waitFor(() =>
    expect(document.querySelector('[data-slot="sidebar"]')).toHaveAttribute("data-collapsible", "icon"),
  );
  expect(switcher.querySelector("span.group-data-\\[collapsible\\=icon\\]\\:hidden")).toBeInTheDocument();
  expect(switcher).toHaveTextContent("U");
});

it("changes servers without dropping the rest of the URL query", async () => {
  const user = userEvent.setup();
  renderShell();

  await user.click(await screen.findByRole("button", { name: "Server: Event server" }));
  await user.click(screen.getByRole("menuitem", { name: /Primary server/ }));

  expect(mocks.push).toHaveBeenCalledWith("/admin/players?server=primary&view=actions");
});

it("closes the mobile drawer after section navigation", async () => {
  mobileViewport = true;
  const user = userEvent.setup();
  renderShell();

  await user.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
  expect(await screen.findByRole("dialog", { name: "Sidebar" })).toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "Players" }));

  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).not.toBeInTheDocument());
});

it("keeps status in the sticky header and account actions in the footer menu", async () => {
  const user = userEvent.setup();
  renderShell();

  const header = screen.getByRole("banner");
  expect(header).toHaveClass("sticky", "h-12", "border-b");
  expect(await screen.findByText("Local preview connected")).toBeInTheDocument();
  expect(screen.getByText("Sample game data")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Appearance" }));
  await user.click(screen.getByRole("menuitemradio", { name: "Dark" }));
  expect(mocks.setTheme).toHaveBeenCalledWith("dark");

  await user.click(screen.getByRole("button", { name: "Account menu for Alex Operator" }));
  expect(screen.getByText("Local preview")).toBeInTheDocument();
  expect(within(screen.getByRole("menu")).getByText("admin")).toBeInTheDocument();
  await user.click(screen.getByRole("menuitem", { name: "Sign out" }));

  await waitFor(() => expect(mocks.endSession).toHaveBeenCalledWith(staff.csrf, expect.any(AbortSignal)));
  expect(mocks.replace).toHaveBeenCalledWith("/sign-in");
});
