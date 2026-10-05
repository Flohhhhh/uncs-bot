import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AuthPanel } from "~/components/auth-panel";
import { SessionProvider } from "~/components/session-provider";
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
it("redirects an already authenticated sign-in visitor to admin", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ id: "123", name: "Staff", role: "viewer", csrf: "token" })),
  );
  render(
    <SessionProvider>
      <AuthPanel />
    </SessionProvider>,
  );
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/admin"));
});
it("shows denial separately from sign-in connection failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
  render(
    <SessionProvider>
      <AuthPanel />
    </SessionProvider>,
  );
  await screen.findByText("Access denied");
  expect(screen.getByRole("link", { name: "Try signing in again" })).toHaveAttribute("href", "/admin/auth/login");
});
it("shows safe expired or unavailable OAuth messages without echoing arbitrary query input", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  const view = render(
    <SessionProvider>
      <AuthPanel reason="expired" />
    </SessionProvider>,
  );
  await screen.findByText("Sign-in expired. Start again with Discord.");
  view.rerender(
    <SessionProvider>
      <AuthPanel reason="unavailable" />
    </SessionProvider>,
  );
  expect(screen.getByText("Discord sign-in could not be reached. Try again shortly.")).toBeInTheDocument();
  view.rerender(
    <SessionProvider>
      <AuthPanel reason="code=secret" />
    </SessionProvider>,
  );
  expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
});
it("offers manual connection retry when the backend is offline", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error("private diagnostic"))
    .mockResolvedValue(new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  render(
    <SessionProvider>
      <AuthPanel />
    </SessionProvider>,
  );
  await screen.findByText(/Staff access could not be verified/);
  expect(screen.queryByText(/private diagnostic/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry connection" })).not.toBeInTheDocument());
});
