import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { BackendStatus } from "~/components/backend-status";

it("distinguishes real authentication with sample game data from demo authentication", () => {
  render(<BackendStatus user={{ id: "123", name: "Real Staff", role: "admin", csrf: "token", gameMode: "sample" }} />);
  expect(screen.getByText("Backend connected")).toBeInTheDocument();
  expect(screen.getByText("Sample game data")).toBeInTheDocument();
  expect(screen.queryByText("Local preview connected")).not.toBeInTheDocument();
});
