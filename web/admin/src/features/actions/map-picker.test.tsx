import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext } from "../../app/context";
import { context } from "../players/test-fixtures";
import { MapPicker } from "./map-picker";
import { useState } from "react";
import type { MapSelection } from "../../../../../src/common/server-settings";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const catalog = { maps: [{ id: "Kavkazi" }], lightings: [{ id: "DayClear" }], experiences: [{ id: "KOTH" }] };
it("rechecks unavailable options without changing the staff selection", async () => {
  request.mockRejectedValueOnce(new Error("Options unavailable"));
  request.mockResolvedValueOnce({ experiences: catalog.experiences, zones: ["Zone.Default"] });
  const change = vi.fn(),
    ready = vi.fn();
  render(
    <AdminContext.Provider value={context()}>
      <MapPicker
        catalog={catalog}
        value={{ map: "Kavkazi", experiences: ["KOTH"], zoneAlternator: "Zone.Default" }}
        change={change}
        onReadyChange={ready}
      />
    </AdminContext.Provider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Retry map options" }));
  expect(ready).toHaveBeenLastCalledWith(false);
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
  expect(screen.getByRole("checkbox", { name: "King of the Hill" })).toBeChecked();
  expect(screen.getByRole("combobox", { name: /Zone layout/ })).toHaveValue("Zone.Default");
  expect(change).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.every(([path, options]) => path === "catalog/maps/Kavkazi" && !options?.method)).toBe(true);
});
it("presents game names while preserving exact catalog IDs, and waits for valid options", async () => {
  request.mockResolvedValue({
    experiences: [{ id: "Madrid_KOTH_01" }, { id: "KOTH_Hardcore" }],
    zones: ["ZoneAlternator.Ozeti.Church.Circle"],
  });
  const change = vi.fn(),
    ready = vi.fn();
  function Fixture() {
    const [value, setValue] = useState<MapSelection>({ map: "", experiences: [] });
    return (
      <AdminContext.Provider value={context()}>
        <MapPicker
          catalog={{
            ...catalog,
            maps: [{ id: "Europe" }, { id: "NorthAmerica" }, { id: "Future", displayName: "New map" }],
          }}
          value={value}
          onReadyChange={ready}
          change={(next) => {
            change(next);
            setValue(next);
          }}
        />
      </AdminContext.Provider>
    );
  }
  render(<Fixture />);
  expect(screen.getByRole("option", { name: "Zestafona" })).toHaveValue("NorthAmerica");
  expect(screen.getByRole("option", { name: "New map" })).toHaveValue("Future");
  fireEvent.change(screen.getByRole("combobox", { name: "Map" }), { target: { value: "Europe" } });
  fireEvent.click(await screen.findByRole("checkbox", { name: "Standard" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Hardcore" }));
  fireEvent.change(screen.getByRole("combobox", { name: /Zone layout/ }), {
    target: { value: "ZoneAlternator.Ozeti.Church.Circle" },
  });
  expect(change).toHaveBeenLastCalledWith({
    map: "Europe",
    experiences: ["Madrid_KOTH_01", "KOTH_Hardcore"],
    zoneAlternator: "ZoneAlternator.Ozeti.Church.Circle",
  });
  expect(ready).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole("option", { name: "Church" })).toBeInTheDocument();
});
beforeEach(() => {
  request.mockReset();
});
it("keeps unavailable saved values visible instead of silently displaying map defaults", async () => {
  request.mockResolvedValue({ experiences: catalog.experiences, zones: ["Zone.Default"] });
  const change = vi.fn();
  render(
    <AdminContext.Provider value={context()}>
      <MapPicker
        catalog={catalog}
        value={{ map: "Kavkazi", experiences: ["RemovedMode"], lighting: "RemovedLight", zoneAlternator: "Zone.River" }}
        change={change}
      />
    </AdminContext.Provider>,
  );
  await screen.findByRole("option", { name: "Unavailable: Zone.River" });
  expect(screen.getByRole("combobox", { name: /Zone layout/ })).toHaveValue("Zone.River");
  expect(screen.getByRole("option", { name: "Unavailable: RemovedLight" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "Unavailable: RemovedMode" }));
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ experiences: [], zoneAlternator: "Zone.River" }));
  expect(screen.getByText(/This saved layout is not in the current catalog/)).toBeInTheDocument();
});
it("shows a pending saved zone honestly and maps the documented None sentinel to the default", async () => {
  request.mockReturnValue(new Promise(() => {}));
  const view = render(
    <AdminContext.Provider value={context()}>
      <MapPicker
        catalog={catalog}
        value={{ map: "Kavkazi", experiences: [], zoneAlternator: "Zone.River" }}
        change={vi.fn()}
      />
    </AdminContext.Provider>,
  );
  expect(screen.getByRole("option", { name: "Saved: Zone.River" })).toBeInTheDocument();
  expect(screen.getByText("Loading zone layouts…")).toBeInTheDocument();
  expect(screen.queryByText("This server has not supplied zone layouts.")).not.toBeInTheDocument();
  view.rerender(
    <AdminContext.Provider value={context()}>
      <MapPicker
        catalog={catalog}
        value={{ map: "Kavkazi", experiences: [], zoneAlternator: "None" }}
        change={vi.fn()}
      />
    </AdminContext.Provider>,
  );
  expect(screen.getByRole("combobox", { name: /Zone layout/ })).toHaveValue("");
});
