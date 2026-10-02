import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  expect(screen.getByRole("combobox", { name: "Game mode" })).toHaveValue("KOTH");
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
  await screen.findByRole("option", { name: "King of the Hill" });
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
  fireEvent.change(screen.getByRole("combobox", { name: "Game mode" }), { target: { value: "" } });
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
  expect(screen.getByText("Loading map options…")).toBeInTheDocument();
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
it("orders the fields by what depends on the map and summarizes the round beside its button", async () => {
  request.mockResolvedValue({
    experiences: [{ id: "KOTH" }, { id: "KOTH_InfantryOnly" }, { id: "KOTH_Hardcore" }],
    zones: ["ZoneAlternator.Ozeti.Farmland.Circle"],
  });
  function Fixture() {
    const [value, setValue] = useState<MapSelection>({ map: "", experiences: [] });
    return (
      <AdminContext.Provider value={context()}>
        <MapPicker catalog={{ ...catalog, maps: [{ id: "Europe" }] }} value={value} change={setValue}>
          <button type="button">Queue next map</button>
        </MapPicker>
      </AdminContext.Provider>
    );
  }
  const { container } = render(<Fixture />);
  const fields = () =>
    [...container.querySelectorAll(".map-picker-fields > *")].map((field) => field.firstChild?.textContent);
  expect(fields()).toEqual(["Map", "Game mode", "Zone layout", "Lighting"]);
  expect(screen.queryByRole("group", { name: "Rules" })).not.toBeInTheDocument();
  expect(container.querySelector(".map-picker-status")).toBeNull();
  const footer = screen.getByRole("button", { name: "Queue next map" }).closest(".map-picker-footer")!;
  expect(footer).toHaveTextContent(/^Queue next map$/);
  fireEvent.change(screen.getByRole("combobox", { name: "Map" }), { target: { value: "Europe" } });
  expect(screen.getByText("Loading map options…")).toBeInTheDocument();
  const rules = await screen.findByRole("group", { name: "Rules" });
  expect(fields()).toEqual(["Map", "Game mode", "Zone layout", "Rules", "Lighting"]);
  expect(within(rules).getAllByRole("checkbox")).toHaveLength(2);
  expect(container.querySelector(".map-picker-status")).toBeNull();
  expect(screen.queryByText(/Leave both off/)).not.toBeInTheDocument();
  expect(screen.queryByText("Only options advertised by this server.")).not.toBeInTheDocument();
  expect(screen.queryByText("Choose a control-zone layout.")).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Game mode" }), { target: { value: "KOTH" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Zone layout" }), {
    target: { value: "ZoneAlternator.Ozeti.Farmland.Circle" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Lighting" }), { target: { value: "DayClear" } });
  expect(footer).toHaveTextContent("Queue next mapSelected: Ozeti · King of the Hill · Farmland · Day clear");
});
it("explains missing zone layouts in the single status line", async () => {
  request.mockResolvedValue({ experiences: catalog.experiences, zones: null });
  render(
    <AdminContext.Provider value={context()}>
      <MapPicker catalog={catalog} value={{ map: "Kavkazi", experiences: [] }} change={vi.fn()} />
    </AdminContext.Provider>,
  );
  expect(await screen.findByText("This server has not supplied zone layouts.")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Zone layout" })).toBeDisabled();
});
