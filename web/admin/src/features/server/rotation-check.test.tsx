import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context } from "../players/test-fixtures";
import { SavedRotationCheck } from "./rotation-check";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
function page(revision = "r1") {
  return (
    <AdminContext.Provider value={context()}>
      <SavedRotationCheck revision={revision} />
    </AdminContext.Provider>
  );
}
beforeEach(() => {
  request.mockReset();
});
it("reports saved mismatches compactly and never represents a failed refresh as a clean rotation", async () => {
  request
    .mockResolvedValueOnce({
      revision: "r1",
      total: 73,
      issues: [10, 22, 34, 46, 58, 70].map((index) => ({
        index,
        unavailable: true,
        message: "Kavkazi: River is not available",
      })),
    })
    .mockRejectedValueOnce(new Error("Read failed"));
  render(page());
  await screen.findByText("6 of 73 saved entries need attention.");
  fireEvent.click(screen.getByText("Show entries to review"));
  expect(screen.getByText("Entries 11, 23, 35, 47, 59, 71: Kavkazi: River is not available")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Check saved rotation" }));
  await screen.findByText("The saved rotation could not be checked.");
  expect(screen.queryByText("6 of 73 saved entries need attention.")).not.toBeInTheDocument();
  expect(request.mock.calls.every(([, options]) => !options?.body)).toBe(true);
});
it("does not apply a check from a different configuration revision", async () => {
  request.mockResolvedValue({ revision: "r1", total: 3, issues: [] });
  const view = render(page());
  await screen.findByText("All 3 saved entries match the current catalog.");
  view.rerender(page("r2"));
  expect(screen.queryByText("All 3 saved entries match the current catalog.")).not.toBeInTheDocument();
  expect(screen.getByText("Settings changed. Refresh settings and check the rotation again.")).toBeInTheDocument();
});
