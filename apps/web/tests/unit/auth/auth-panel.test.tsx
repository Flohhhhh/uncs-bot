import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { AuthPanel } from "~/components/auth-panel";

it("shows access denial without a sign-in loading state", () => {
  render(<AuthPanel denied />);
  expect(screen.getByText("Access denied")).toBeInTheDocument();
  expect(screen.queryByText(/Checking staff access/)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Try signing in again" })).toHaveAttribute("href", "/admin/auth/login");
});

it("shows safe expired or unavailable OAuth messages without echoing arbitrary query input", () => {
  const view = render(<AuthPanel reason="expired" />);
  expect(screen.getByText("Sign-in expired. Start again with Discord.")).toBeInTheDocument();

  view.rerender(<AuthPanel reason="unavailable" />);
  expect(screen.getByText("Discord sign-in could not be reached. Try again shortly.")).toBeInTheDocument();

  view.rerender(<AuthPanel reason="code=secret" />);
  expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
});

it("shows a manual retry when the server cannot verify the session", () => {
  render(<AuthPanel unavailableMessage="Staff access could not be verified." />);
  expect(screen.getByRole("alert")).toHaveTextContent("Staff access could not be verified.");
  expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/sign-in");
});
