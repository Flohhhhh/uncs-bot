import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { AdminContext } from "../../app/context";
import { alice, bob, context } from "../players/test-fixtures";
import { OverviewPage } from "./pages";

vi.mock("../../api/client", () => ({ api: vi.fn() }));

it("opens the chosen overview player's controls without making staff search again", () => {
  const admin = context();
  render(
    <MemoryRouter initialEntries={["/admin/overview?server=primary"]}>
      <AdminContext.Provider value={admin}>
        <OverviewPage />
      </AdminContext.Provider>
    </MemoryRouter>,
  );
  const row = screen.getByText(bob.name).closest("tr")!;
  fireEvent.click(within(row).getByRole("button", { name: /View player/ }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(bob.steamId)).toBeInTheDocument();
  expect(within(dialog).queryByText(alice.steamId)).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Message player" }));
  expect(admin.openAction).toHaveBeenCalledWith("message", bob.steamId);
});
