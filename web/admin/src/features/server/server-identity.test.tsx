import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context } from "../players/test-fixtures";
import { ServerIdentityReadout } from "./server-identity";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const identity = {
  serverId: { available: true, value: "event-server-id" },
  banner: { available: true, value: "https://example.com/banner.png" },
};
function page(id = "event") {
  return (
    <AdminContext.Provider value={{ ...context(), server: { id, name: id, version: "1".repeat(64), role: "admin" } }}>
      <ServerIdentityReadout key={id} />
    </AdminContext.Provider>
  );
}
function open() {
  const details = screen.getByText("Server ID & current banner").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}
beforeEach(() => request.mockReset());

it("loads identity only when opened, targeting the selected server without loading its remote image", async () => {
  request.mockResolvedValue(identity);
  render(page());
  expect(request).not.toHaveBeenCalled();
  open();
  expect(await screen.findByText("event-server-id")).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith(
    "servers/event/server-identity",
    expect.objectContaining({ signal: expect.anything() }),
  );
  expect(screen.getByRole("link", { name: /Open reported image/ })).toHaveAttribute("href", identity.banner.value);
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

it("clears old identity on read failure, supports retry, and clears the prior server on switch", async () => {
  request
    .mockResolvedValueOnce(identity)
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValueOnce(identity);
  const view = render(page());
  open();
  await screen.findByText("event-server-id");
  fireEvent.click(screen.getByRole("button", { name: "Refresh identity" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("event-server-id")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh identity" }));
  await screen.findByText("event-server-id");
  request.mockReturnValueOnce(new Promise(() => {}));
  view.rerender(page("primary"));
  expect(screen.queryByText("event-server-id")).not.toBeInTheDocument();
  open();
  await waitFor(() => expect(request).toHaveBeenCalledWith("servers/primary/server-identity", expect.anything()));
  expect(screen.getByText("Loading server identity…")).toBeInTheDocument();
});

it("distinguishes an unsupported route, an empty value, and a failed field", async () => {
  request.mockResolvedValueOnce({
    serverId: { available: false, value: null },
    banner: { available: true, value: null },
  });
  render(page());
  open();
  await screen.findByText("Not provided by this build");
  expect(screen.getByText("Not set")).toBeInTheDocument();
  request.mockResolvedValueOnce({
    ...identity,
    banner: { available: true, value: null, error: "The current banner could not be read." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh identity" }));
  await screen.findByText("The current banner could not be read.");
  expect(screen.getByText("event-server-id")).toBeInTheDocument();
});
