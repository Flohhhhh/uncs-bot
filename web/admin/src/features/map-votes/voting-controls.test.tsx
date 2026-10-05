import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context } from "../players/test-fixtures";
import { VotingControlsPanel } from "./voting-controls";
import {
  defaultVotingPolicy,
  defaultVotingSettings,
  votingSettingLimits,
  type VotingControls,
  type VotingSettings,
} from "../../../../../src/common/voting-policy";
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
it("resumes paused automatic voting by saving the unchanged controls", async () => {
  const pause =
    "Paused after 3 refused results (Not queued: The current round changed. The rotation continues.). Save the voting controls to resume.";
  saved = { ...saved, version: 4, ready: true, policy: { ...defaultVotingPolicy, enabled: true, mapChoices: true } };
  saved.paused = pause;
  const base = request.getMockImplementation()!;
  request.mockImplementation(async (path, options) => {
    // Any save starts a new version, which ends the pause.
    if (options?.method === "POST") saved.paused = null;
    return base(path, options);
  });
  const { onDirty } = show();
  expect(await screen.findByRole("alert")).toHaveTextContent(`Automatic voting is paused. ${pause}`);
  // Nothing was changed, so the ordinary save is not offered; the resume save is.
  expect(screen.queryByRole("button", { name: "Save voting controls" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save to resume" }));
  await screen.findByText("Voting controls saved unchanged. Automatic voting resumes.");
  const posts = request.mock.calls.filter(([, options]) => options?.method === "POST");
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0][1]!.body as string)).toEqual({
    serverId: "primary",
    version: 4,
    policy: { ...defaultVotingPolicy, enabled: true, mapChoices: true },
  });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Save to resume" })).not.toBeInTheDocument());
  expect(screen.queryByText(/Automatic voting is paused/)).not.toBeInTheDocument();
  expect(onDirty).not.toHaveBeenCalledWith(true);
});
it("offers no resume save while voting is off or not paused", async () => {
  saved.paused = "Paused after 3 refused results (Refused). Save the voting controls to resume.";
  show();
  await screen.findByRole("checkbox", { name: "Automatic community voting" });
  expect(screen.queryByRole("button", { name: "Save to resume" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Automatic voting is paused/)).not.toBeInTheDocument();
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

/** Controls as the current backend returns them: its saved settings, their limits and the game's context. */
function withSettings(settings: Partial<VotingSettings> = {}) {
  saved = {
    ...saved,
    settings: { ...structuredClone(defaultVotingSettings), ...settings },
    limits: votingSettingLimits,
    context: {
      startThreshold: 20,
      factions: [],
      eventsEnabled: false,
      routes: { kill: false, message: false },
      fifty: { available: false, message: "Voted 50v50 is held for the owner's in-person review." },
    },
  };
  const base = request.getMockImplementation()!;
  request.mockImplementation(async (path, options) => {
    if (options?.method === "POST") {
      const patch = JSON.parse(options.body as string).settings ?? {};
      const current = saved.settings!;
      saved.settings = {
        ...current,
        ...patch,
        reminders: {
          midpoint: { ...current.reminders.midpoint, ...patch.reminders?.midpoint },
          final: { ...current.reminders.final, ...patch.reminders?.final },
        },
        announce: { ...current.announce, ...patch.announce },
      };
    }
    return base(path, options);
  });
}
const posts = () =>
  request.mock.calls
    .filter(([, options]) => options?.method === "POST")
    .map(([, options]) => JSON.parse(options!.body as string));
it("describes the backend's ballot from its saved settings, including in-game announcements", async () => {
  withSettings();
  show();
  await screen.findByText("Ballots offer up to 3 map/mode combinations from the saved rotation.");
  expect(
    screen.getByText(
      "A ballot opens once at least 40 players are online, 3 minutes into the round, and only while the leading team has fewer than 70 points.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Voting closes when the leading team reaches 95 points, or from 85 when one more scoring step/),
  ).toBeInTheDocument();
  expect(screen.getByText("No reminders are sent.")).toBeInTheDocument();
  expect(
    screen.getByText(
      "In game, Gramps also broadcasts a notice when each ballot opens and the winner, a tie or no votes when each ballot ends.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText(/up to five/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Voting closes at 95/)).not.toBeInTheDocument();
});
it("follows changed settings in the copy and the reminder switches", async () => {
  withSettings({
    optionCount: 4,
    minPlayers: 10,
    openDelaySeconds: 90,
    openScoreCeiling: 60,
    closeAtScore: 90,
    reminders: {
      midpoint: { score: 40, discord: true, inGame: false },
      final: { score: 80, discord: false, inGame: true },
    },
    announce: { openInGame: false, resultInGame: false },
    tieRule: "first_option",
  });
  saved.policy = { ...defaultVotingPolicy, midpointReminder: true, finalReminder: true };
  show();
  await screen.findByText("Ballots offer up to 4 map/mode combinations from the saved rotation.");
  expect(
    screen.getByText(
      "A ballot opens once at least 20 players are online (the game needs 20 to start a match), 90 seconds into the round, and only while the leading team has fewer than 60 points.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText(/reaches 90 points, or from 80 when one more scoring step/)).toBeInTheDocument();
  expect(screen.getByText(/A tie goes to the first tied option/)).toBeInTheDocument();
  expect(
    screen.getByText(
      "Gramps sends an update with current totals at 40 points in Discord only and a last-chance reminder at 80 points in game only.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("Gramps broadcasts nothing in game when a ballot opens or ends.")).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Score 40 update · current vote totals" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Score 80 reminder · last chance to vote" })).toBeChecked();
});
it("lists every in-game broadcast in the enable confirmation", async () => {
  withSettings();
  saved.ready = true;
  saved.policy = { ...defaultVotingPolicy, finalReminder: true };
  show();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Automatic community voting" }));
  fireEvent.click(screen.getByRole("button", { name: "Save voting controls" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Enable automatic voting for this server? Gramps will post ballots and queue community winners for the next round. In game, it will also broadcast a notice when each ballot opens, a last-chance reminder at 85 points and the winner, a tie or no votes when each ballot ends.",
  );
  expect(posts()).toHaveLength(0);
  // With the announcements off and no in-game reminder, the confirmation says nothing is broadcast.
  fireEvent.click(screen.getByRole("checkbox", { name: "Announce each ballot in game when it opens" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Announce the result in game when a ballot ends" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Score 85 reminder/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save voting controls" }));
  expect(screen.getByRole("alert")).toHaveTextContent("It will not broadcast anything in game.");
});
it("saves only the changed ballot settings with the switches", async () => {
  withSettings();
  const { onDirty } = show();
  const options = await screen.findByRole("spinbutton", { name: "Options per ballot" });
  expect(options).toHaveValue(3);
  expect(options).toHaveAttribute("min", "2");
  expect(options).toHaveAttribute("max", "5");
  expect(screen.getByRole("spinbutton", { name: "Minimum players" })).toHaveValue(40);
  expect(screen.getByRole("spinbutton", { name: "Opening delay (seconds)" })).toHaveValue(180);
  expect(screen.getByRole("spinbutton", { name: "Opening score limit" })).toHaveValue(70);
  expect(screen.getByRole("spinbutton", { name: "Close score" })).toHaveValue(95);
  expect(screen.getByRole("spinbutton", { name: "Update reminder score" })).toHaveValue(50);
  expect(screen.getByRole("spinbutton", { name: "Last-chance reminder score" })).toHaveValue(85);
  expect(screen.getByRole("checkbox", { name: "Announce each ballot in game when it opens" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Announce the result in game when a ballot ends" })).toBeChecked();
  fireEvent.change(options, { target: { value: "4" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Minimum players" }), { target: { value: "30" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Last-chance reminder score" }), { target: { value: "80" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Announce each ballot in game when it opens" }));
  expect(onDirty).toHaveBeenLastCalledWith(true);
  expect(screen.getByText("Ballots offer up to 4 map/mode combinations from the saved rotation.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save voting controls" }));
  await screen.findByText("Voting controls saved.");
  expect(posts()).toEqual([
    {
      serverId: "primary",
      version: 0,
      policy: defaultVotingPolicy,
      settings: {
        optionCount: 4,
        minPlayers: 30,
        reminders: { final: { score: 80 } },
        announce: { openInGame: false },
      },
    },
  ]);
  await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Options per ballot" })).toHaveValue(4));
  expect(screen.getByRole("checkbox", { name: "Announce each ballot in game when it opens" })).not.toBeChecked();
  expect(onDirty).toHaveBeenLastCalledWith(false);
});
it("refuses settings outside the backend's limits or rules before saving, and drops a reverted edit", async () => {
  withSettings();
  show();
  const options = await screen.findByRole("spinbutton", { name: "Options per ballot" });
  fireEvent.change(options, { target: { value: "9" } });
  expect(screen.getByRole("alert")).toHaveTextContent("Options per ballot must be a whole number from 2 to 5.");
  expect(screen.getByRole("button", { name: "Save voting controls" })).toBeDisabled();
  fireEvent.change(options, { target: { value: "3" } });
  // Back to the saved value: nothing to save.
  expect(screen.queryByRole("button", { name: "Save voting controls" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Opening score limit" }), { target: { value: "92" } });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Close score must be at least 5 points above the opening ceiling.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save voting controls" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Opening score limit" }), { target: { value: "70" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Score 85 reminder/ }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Last-chance reminder score" }), { target: { value: "96" } });
  expect(screen.getByRole("alert")).toHaveTextContent("The last-chance reminder must come before the close score.");
  expect(screen.getByRole("button", { name: "Save voting controls" })).toBeDisabled();
  expect(posts()).toHaveLength(0);
});
