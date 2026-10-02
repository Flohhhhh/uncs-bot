import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  expect(screen.queryByText(/A catalog match does not prove/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Show entries to review"));
  expect(screen.getByText("Entries 11, 23, 35, 47, 59, 71: Kavkazi: River is not available")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Check saved rotation" }));
  await screen.findByText("The saved rotation could not be checked.");
  expect(screen.queryByText("6 of 73 saved entries need attention.")).not.toBeInTheDocument();
  expect(request.mock.calls.every(([, options]) => !options?.body)).toBe(true);
});
it("shows nothing for a clean rotation and checks a newer saved rotation once", async () => {
  request.mockResolvedValue({ revision: "r1", total: 3, issues: [] });
  const view = render(page());
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(view.container).toBeEmptyDOMElement();
  expect(screen.queryByText(/A catalog match does not prove/)).not.toBeInTheDocument();
  view.rerender(page("r2"));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("The saved rotation changed after it was checked.")).toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(2);
  request.mockResolvedValue({ revision: "r2", total: 3, issues: [] });
  fireEvent.click(screen.getByRole("button", { name: "Check saved rotation" }));
  await waitFor(() => expect(view.container).toBeEmptyDOMElement());
  expect(request.mock.calls.every(([path, options]) => path === "settings/rotation-check" && !options?.method)).toBe(
    true,
  );
});
it("stays quiet while a newer saved rotation is checked again", async () => {
  request.mockResolvedValue({ revision: "r1", total: 3, issues: [] });
  const view = render(page());
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  await act(async () => {});
  let finish!: (value: unknown) => void;
  request.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
  );
  view.rerender(page("r2"));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  // The earlier answer stays loaded during the re-check, which must not read as a changed rotation.
  expect(view.container).toBeEmptyDOMElement();
  await act(async () => finish({ revision: "r2", total: 3, issues: [] }));
  expect(view.container).toBeEmptyDOMElement();
});
