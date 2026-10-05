import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BackendStatus } from "~/components/backend-status";
import { SessionProvider } from "~/components/session-provider";

it("distinguishes real authentication with sample game data from demo authentication", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ id: "123", name: "Real Staff", role: "admin", csrf: "token", gameMode: "sample" }),
      ),
  );
  render(
    <SessionProvider>
      <BackendStatus />
    </SessionProvider>,
  );
  await screen.findByText("Sample game data");
  expect(screen.getByText("Backend connected")).toBeInTheDocument();
  expect(screen.queryByText("Local preview connected")).not.toBeInTheDocument();
});
