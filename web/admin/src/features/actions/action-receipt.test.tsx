import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext, type SelectedServer } from "../../app/context";
import { context } from "../players/test-fixtures";
import { ActionReceipt } from "./action-receipt";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const id = "7ab342f1-4200-4dfe-9050-5d7f2c310151";
const server: SelectedServer = { id: "east", name: "East", version: "1".repeat(64), role: "moderator" };
const receipt = { record: { id, state: "applied", message: "Assignment confirmed in the game." } };
const tree = (selected = server, refreshVersion = 0) => (
  <AdminContext.Provider value={context({ server: selected, refreshVersion })}>
    <ActionReceipt id={id} />
  </AdminContext.Provider>
);
function check() {
  fireEvent.click(screen.getByText("Action details"));
  fireEvent.click(screen.getByRole("button", { name: "Check saved result" }));
}
beforeEach(() => request.mockReset());

it("reads the exact server receipt only on demand, without polling or sending an action", async () => {
  request.mockResolvedValue(receipt);
  const { rerender } = render(tree());
  expect(request).not.toHaveBeenCalled();
  check();
  const saved = await screen.findByRole("status", { name: "Saved action result" });
  expect(saved).toHaveTextContent("Recorded outcome: Applied");
  expect(within(saved).getByText("Applied")).toHaveClass("pill", "good");
  const [path, options] = request.mock.calls[0];
  expect(path).toBe(`servers/east/audit/${id}`);
  expect(options?.body).toBeUndefined();
  expect(options?.method).toBeUndefined();
  expect(new Headers(options?.headers).get("X-UNCs-Server-Version")).toBe(server.version);
  expect(screen.getByText(/does not resend the action or recheck the game/)).toBeInTheDocument();
  rerender(tree(server, 1));
  expect(request).toHaveBeenCalledOnce();
  request.mockRejectedValueOnce(new Error("The saved result is unavailable."));
  fireEvent.click(screen.getByRole("button", { name: "Check saved result" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("status", { name: "Saved action result" })).not.toBeInTheDocument();
});

it.each([
  ["accepted", "Accepted · not verified"],
  ["started", "Unconfirmed"],
] as const)("labels a recorded %s receipt with the shared outcome wording", async (state, label) => {
  request.mockResolvedValue({ record: { ...receipt.record, state } });
  render(tree());
  check();
  const saved = await screen.findByRole("status", { name: "Saved action result" });
  expect(saved).toHaveTextContent(`Recorded outcome: ${label}`);
  expect(within(saved).getByText(label)).toHaveClass("pill", "warn");
});

it("does not treat an absent receipt as a safe retry and can retry a failed read", async () => {
  request.mockRejectedValueOnce(new Error("Storage unavailable")).mockResolvedValueOnce({ record: null });
  render(tree());
  check();
  expect(await screen.findByRole("alert")).toHaveTextContent("Storage unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Check saved result" }));
  expect(await screen.findByRole("status", { name: "Saved action result" })).toHaveTextContent(
    "No stored receipt found",
  );
  expect(screen.getByText(/does not establish whether the game acted/)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(request.mock.calls.every(([path, options]) => path.endsWith(`/audit/${id}`) && !options?.body)).toBe(true);
});

it.each([
  { record: { ...receipt.record, id: "9ef564a2-4300-4afc-8050-8f3e7c240362" } },
  { record: { ...receipt.record, state: "invented" } },
  {},
])("does not display a mismatched or unreadable receipt as confirmation", async (response) => {
  request.mockResolvedValue(response);
  render(tree());
  check();
  expect(await screen.findByRole("alert")).toHaveTextContent("did not match this action");
  expect(screen.queryByRole("status", { name: "Saved action result" })).not.toBeInTheDocument();
});

it("cancels an unfinished read and hides its result when the selected server changes", async () => {
  let finish!: (value: unknown) => void;
  request
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(receipt);
  const { rerender } = render(tree());
  check();
  expect(screen.getByRole("button", { name: "Checking saved result…" })).toBeDisabled();
  const signal = request.mock.calls[0][1]?.signal;
  rerender(tree({ ...server, id: "west", name: "West" }));
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(receipt));
  expect(screen.queryByRole("status", { name: "Saved action result" })).not.toBeInTheDocument();
  check();
  await screen.findByRole("status", { name: "Saved action result" });
  expect(request.mock.calls[1][0]).toBe(`servers/west/audit/${id}`);
});
