import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { VoteResults, voteSummary, type VoteList } from "./vote-status";
import { defaultVotingPolicy, defaultVotingSettings } from "../../../../../src/common/voting-policy";
const ballot: VoteList = {
  enabled: true,
  serverId: "event",
  observedAt: "2026-10-02T04:00:00Z",
  votes: [
    {
      id: "test-ballot",
      serverId: "event",
      serverName: "Event server",
      actorName: "Staff",
      reason: "Community choice",
      state: "open",
      winner: null,
      choices: [
        { map: "Kavkazi", experiences: ["KOTH_InfantryOnly"] },
        { map: "Europe", experiences: [] },
      ],
      counts: [4, 2],
      counted: true,
      createdAt: "2026-10-02T03:55:00Z",
      closesAt: "2026-10-02T04:05:00Z",
      message: "Voting open.",
      cancellation: null,
      automation: null,
      messageUrl: null,
    },
  ],
};
it("shows live per-choice totals and shares without claiming an open ballot has a winner", () => {
  render(<VoteResults data={ballot} />);
  expect(screen.getByText("4 votes")).toBeInTheDocument();
  expect(screen.getByText("2 votes")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "Bakurani · Infantry only votes" })).toHaveAttribute("value", "4");
  expect(screen.getByRole("progressbar", { name: "Ozeti · Map defaults votes" })).toHaveAttribute("max", "6");
  expect(screen.queryByText(/Winner/)).not.toBeInTheDocument();
});
it("marks stale totals and distinguishes the last result from an active next-round vote", () => {
  render(
    <VoteResults
      data={{ ...ballot, votes: [{ ...ballot.votes[0], state: "queued", winner: 0 }] }}
      error="Read failed"
    />,
  );
  expect(screen.getByText("Last map vote")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("last successful check");
  expect(screen.getByText("Status unavailable")).toBeInTheDocument();
});
it("qualifies a previously disabled status when its next read fails", () => {
  render(<VoteResults data={{ enabled: false, serverId: "primary", votes: [] }} error="Read failed" />);
  expect(screen.getByText("Status unavailable")).toBeInTheDocument();
  expect(screen.getByText("Voting was off at the last successful check.")).toBeInTheDocument();
  expect(
    screen.queryByText("Community voting is not enabled. The saved rotation chooses the next map."),
  ).not.toBeInTheDocument();
});
it("summarizes voting in one short line without presenting a failed read as current", () => {
  const ends = new Date(ballot.votes[0].closesAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  expect(voteSummary(ballot)).toEqual({ label: `Open · ends ${ends}`, kind: "good" });
  expect(voteSummary({ ...ballot, votes: [{ ...ballot.votes[0], state: "queued" }] }).label).toBe("None");
  expect(voteSummary({ ...ballot, votes: [{ ...ballot.votes[0], state: "needs_review" }] })).toEqual({
    label: "Needs review",
    kind: "warn",
  });
  expect(voteSummary({ ...ballot, enabled: false }).label).toBe("Off");
  expect(voteSummary(ballot, "Read failed")).toEqual({ label: "Unavailable", kind: "warn" });
  expect(voteSummary(null).label).toBe("Checking…");
  expect(voteSummary(null, "Read failed").label).toBe("Unavailable");
});
it("states an automatic ballot's own close score and its early close", () => {
  const settings = {
    ...defaultVotingSettings,
    closeAtScore: 90,
    reminders: { ...defaultVotingSettings.reminders, midpoint: { score: 40, discord: true, inGame: true } },
  };
  const automatic: VoteList = {
    ...ballot,
    votes: [
      {
        ...ballot.votes[0],
        automation: {
          policy: { ...defaultVotingPolicy, enabled: true, midpointReminder: true },
          settings,
          highestScore: 45,
          reminders: { midpoint: { id: "r", state: "applied", message: "Sent", at: "2026-10-02T03:58:00Z" } },
        },
      },
    ],
  };
  expect(voteSummary(automatic).label).toBe("Open · ends by 90 points");
  render(<VoteResults data={automatic} />);
  expect(
    screen.getByText(/Closes when the leading team reaches 90 points, or from 80 if one more scoring step could end/),
  ).toBeInTheDocument();
  expect(screen.getByText("Score 40 update: sent")).toBeInTheDocument();
  expect(screen.queryByText(/95/)).not.toBeInTheDocument();
});
it("keeps the exact close score for a ballot stored before customizable settings", () => {
  const older: VoteList = {
    ...ballot,
    votes: [{ ...ballot.votes[0], automation: { policy: defaultVotingPolicy, highestScore: 30, reminders: {} } }],
  };
  expect(voteSummary(older).label).toBe("Open · ends at 95 points");
  render(<VoteResults data={older} />);
  expect(screen.getByText(/^Closes when the leading team reaches 95 points/)).toHaveTextContent(
    "Closes when the leading team reaches 95 points · 6 votes",
  );
});
