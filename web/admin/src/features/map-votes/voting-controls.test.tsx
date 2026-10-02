import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context } from "../players/test-fixtures";
import { VotingControlsPanel } from "./voting-controls";
import { defaultVotingPolicy, type VotingControls } from "../../../../../src/common/voting-policy";
vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
let saved: VotingControls;
beforeEach(() => {
  vi.clearAllMocks();
  saved = {
    serverId: "primary",
    version: 0,
    available: true,
    ready: false,
    policy: { ...defaultVotingPolicy },
    message: "Live voting is off.",
  };
  request.mockImplementation(async (_path, options) => {
    if (options?.method === "POST") {
      const body = JSON.parse(options.body as string);
      saved = { ...saved, policy: body.policy, version: body.version + 1 };
    }
    return structuredClone(saved) as never;
  });
});
function show() {
  const onDirty = vi.fn();
  const state = context();
  render(
    <AdminContext.Provider value={state}>
      <VotingControlsPanel onDirty={onDirty} />
    </AdminContext.Provider>,
    { wrapper: MemoryRouter },
  );
  return { onDirty };
}
it("keeps voting and reminders off and saves independent preferences without activating", async () => {
  const { onDirty } = show();
  const master = await screen.findByRole("checkbox", { name: "Automatic community voting" });
  expect(master).not.toBeChecked();
  expect(master).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: /Score 50/ })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: /Score 85/ })).not.toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "Offer different game modes" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Score 50/ }));
  expect(onDirty).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Save voting controls" }));
  await screen.findByText("Voting controls saved.");
  expect(saved.policy).toEqual({ ...defaultVotingPolicy, modeChoices: true, midpointReminder: true });
  expect(request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  expect(onDirty).toHaveBeenLastCalledWith(false);
});
it("requires one extra enable check and no typed phrase", async () => {
  saved.ready = true;
  show();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Automatic community voting" }));
  fireEvent.click(screen.getByRole("button", { name: "Save voting controls" }));
  expect(request.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  expect(screen.getByRole("alert")).toHaveTextContent("queue community winners");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Confirm enable voting" }));
  await screen.findByText("Voting controls saved.");
  expect(saved.policy.enabled).toBe(true);
});
it("does not save a no-op and does not offer working switches when storage is unavailable", async () => {
  show();
  const mode = await screen.findByRole("checkbox", { name: "Offer different game modes" });
  fireEvent.click(mode);
  fireEvent.click(mode);
  expect(screen.queryByRole("button", { name: "Save voting controls" })).not.toBeInTheDocument();
  expect(request.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
});
it("requires a fresh read after an uncertain save before another attempt", async () => {
  show();
  fireEvent.click(await screen.findByRole("checkbox", { name: /Score 85/ }));
  const base = request.getMockImplementation()!;
  request.mockImplementation(async (path, options) => {
    if (options?.method === "POST") throw new Error("Connection lost");
    return base(path, options);
  });
  fireEvent.click(screen.getByRole("button", { name: "Save voting controls" }));
  await screen.findByText(/Connection lost/);
  expect(screen.getByRole("button", { name: "Save voting controls" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload saved controls" }));
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /Score 85/ })).not.toBeChecked());
  expect(request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
});
it("keeps missing-migration controls disabled with an explanation", async () => {
  saved.available = false;
  saved.message = "Voting controls storage is unavailable.";
  show();
  await screen.findByText(saved.message);
  for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).toBeDisabled();
  expect(request.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
});
it("retries a failed first controls read without enabling voting or losing the failure while pending", async () => {
  request.mockRejectedValueOnce(new Error("Controls read failed"));
  show();
  expect(await screen.findByRole("alert")).toHaveTextContent("Controls read failed");
  let finish!: (value: unknown) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Reload saved controls" }));
  expect(screen.getByRole("button", { name: "Reload saved controls" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Controls read failed");
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  await act(async () => finish(saved));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Automatic community voting" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Automatic community voting" })).toBeDisabled();
  expect(request.mock.calls.every(([path, options]) => path === "map-votes/controls" && !options?.method)).toBe(true);
});
it("keeps the switches editable while a background refresh is pending", async () => {
  const state = context();
  const view = (refreshVersion: number) => (
    <AdminContext.Provider value={{ ...state, refreshVersion }}>
      <VotingControlsPanel onDirty={vi.fn()} />
    </AdminContext.Provider>
  );
  const page = render(view(0), { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByRole("checkbox", { name: /Score 85/ }));
  const base = request.getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  request.mockImplementation(async (path, options) => {
    await held;
    return base(path, options);
  });
  page.rerender(view(1));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("checkbox", { name: /Score 50/ })).toBeEnabled();
  expect(screen.getByRole("checkbox", { name: /Score 85/ })).toBeChecked();
  await act(async () => release());
  expect(screen.getByRole("checkbox", { name: /Score 85/ })).toBeChecked();
  expect(request.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
});
it("keeps the switches locked until the saved controls reload after a save", async () => {
  show();
  fireEvent.click(await screen.findByRole("checkbox", { name: /Score 85/ }));
  const base = request.getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  request.mockImplementation(async (path, options) => {
    if (!options?.method) await held;
    return base(path, options);
  });
  fireEvent.click(screen.getByRole("button", { name: "Save voting controls" }));
  await screen.findByText("Voting controls saved.");
  // The switches still show the snapshot from before the save, so a toggle now would build on a stale version.
  expect(screen.getByRole("checkbox", { name: /Score 50/ })).toBeDisabled();
  await act(async () => release());
  expect(screen.getByRole("checkbox", { name: /Score 85/ })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /Score 50/ })).toBeEnabled();
  expect(screen.queryByText(/Another administrator changed/)).not.toBeInTheDocument();
});
it("keeps the switches locked until the saved controls reload after an uncertain save", async () => {
  show();
  fireEvent.click(await screen.findByRole("checkbox", { name: /Score 85/ }));
  const base = request.getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  request.mockImplementation(async (path, options) => {
    if (options?.method === "POST") throw new Error("Connection lost");
    await held;
    return base(path, options);
  });
  fireEvent.click(screen.getByRole("button", { name: "Save voting controls" }));
  await screen.findByText(/Connection lost/);
  fireEvent.click(screen.getByRole("button", { name: "Reload saved controls" }));
  expect(screen.getByRole("checkbox", { name: /Score 50/ })).toBeDisabled();
  await act(async () => release());
  expect(screen.getByRole("checkbox", { name: /Score 50/ })).toBeEnabled();
  expect(screen.getByRole("checkbox", { name: /Score 85/ })).not.toBeChecked();
});
