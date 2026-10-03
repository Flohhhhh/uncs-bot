import type { MapSelection } from "../../../../../src/common/server-settings";
import { mapLabel, modeLabel, lightingLabel, zoneLabel, isModeModifier } from "../../../../../src/common/map-labels";
import type { Catalog } from "../../api/types";
import { useResource } from "../../api/use-resource";
import { useEffect, type ReactNode } from "react";

type MapOptions = { experiences: Catalog["experiences"]; zones: string[] | null };

/** "Ozeti · King of the Hill · Farmland · Day clear", with the server's display names where it gives them. */
export function mapSelectionLabel(value: MapSelection, catalog: Catalog, experiences: Catalog["experiences"] = []) {
  if (!value.map) return "";
  const named = (list: Catalog["maps"], id: string) => list.find((entry) => entry.id === id)?.displayName;
  return [
    mapLabel(value.map, named(catalog.maps, value.map)),
    ...value.experiences.map((id) => modeLabel(id, named(experiences, id) ?? named(catalog.experiences, id))),
    value.zoneAlternator && value.zoneAlternator !== "None" ? zoneLabel(value.zoneAlternator) : "",
    // Lighting labels use their own separator ("Day · clear"); keep one separator per part.
    value.lighting
      ? lightingLabel(value.lighting, named(catalog.lightings, value.lighting)).replaceAll(" · ", " ")
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Map, game mode and zone layout, then rules and lighting. `children` are the buttons that use the
 * selection; the chosen round is summarized beside them.
 */
export function MapPicker({
  value,
  change,
  catalog,
  disabled = false,
  onReadyChange,
  children,
}: {
  value: MapSelection;
  change: (value: MapSelection) => void;
  catalog: Catalog;
  disabled?: boolean;
  onReadyChange?: (ready: boolean) => void;
  children?: ReactNode;
}) {
  const options = useResource<MapOptions>(value.map ? `catalog/maps/${encodeURIComponent(value.map)}` : null);
  const modes = (options.data?.experiences ?? []).filter((entry) => !isModeModifier(entry.id));
  const modifiers = (options.data?.experiences ?? []).filter((entry) => isModeModifier(entry.id));
  const selectedModes = value.experiences.filter((id) => !isModeModifier(id));
  const unavailableModes =
    options.data && !options.loading && !options.error
      ? value.experiences.filter((id) => !options.data!.experiences.some((entry) => entry.id === id))
      : [];
  const unavailableModifiers = unavailableModes.filter(isModeModifier);
  const savedZoneMissing =
    value.zoneAlternator && value.zoneAlternator !== "None" && !options.data?.zones?.includes(value.zoneAlternator);
  const ready =
    !!value.map &&
    catalog.maps.some((entry) => entry.id === value.map) &&
    !options.loading &&
    !options.error &&
    !!options.data &&
    selectedModes.length <= 1 &&
    !unavailableModes.length &&
    !savedZoneMissing &&
    (!value.lighting || catalog.lightings.some((entry) => entry.id === value.lighting));
  useEffect(() => {
    onReadyChange?.(ready);
  }, [ready, onReadyChange]);
  // A hidden picker never leaves its last answer behind.
  useEffect(() => () => onReadyChange?.(false), [onReadyChange]);
  // One line for what stops or delays a choice: loading, a failed read, or data the server did not supply.
  const status = !value.map
    ? ""
    : options.error ||
      (options.loading
        ? "Loading map options…"
        : savedZoneMissing && options.data?.zones
          ? "This saved layout is not in the current catalog. Choose another layout before saving."
          : options.data && !options.data.zones
            ? "This server has not supplied zone layouts."
            : "");
  const summary = mapSelectionLabel(value, catalog, options.data?.experiences);
  return (
    <div className="map-picker">
      <div className="settings-grid map-picker-fields">
        <label>
          Map
          <select
            value={value.map}
            disabled={disabled}
            onChange={(event) =>
              change({ ...value, map: event.target.value, experiences: [], zoneAlternator: undefined })
            }
          >
            <option value="">Choose a map</option>
            {value.map && !catalog.maps.some((entry) => entry.id === value.map) && (
              <option value={value.map}>Unavailable: {mapLabel(value.map)}</option>
            )}
            {catalog.maps.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {mapLabel(entry.id, entry.displayName)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Game mode
          <select
            value={selectedModes.length === 1 ? selectedModes[0] : ""}
            disabled={disabled || options.loading || !!options.error || !value.map}
            onChange={(event) =>
              change({
                ...value,
                experiences: [event.target.value, ...value.experiences.filter(isModeModifier)].filter(Boolean),
              })
            }
          >
            <option value="">Map default</option>
            {modes.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {modeLabel(entry.id, entry.displayName)}
              </option>
            ))}
            {selectedModes
              .filter((id) => !modes.some((entry) => entry.id === id))
              .map((id) => (
                <option key={id} value={id}>
                  Unavailable: {modeLabel(id)}
                </option>
              ))}
          </select>
          {selectedModes.length > 1 && (
            <small>Choose one game mode. Your saved selection contains more than one.</small>
          )}
        </label>
        <label>
          Zone layout
          <select
            value={value.zoneAlternator === "None" ? "" : (value.zoneAlternator ?? "")}
            disabled={disabled || options.loading || !options.data?.zones || !!options.error}
            onChange={(event) => change({ ...value, zoneAlternator: event.target.value || undefined })}
          >
            <option value="">Map default</option>
            {savedZoneMissing && (
              <option value={value.zoneAlternator}>
                {options.loading || options.error || !options.data?.zones ? "Saved" : "Unavailable"}:{" "}
                {zoneLabel(value.zoneAlternator!)}
              </option>
            )}
            {options.data?.zones?.map((zone) => (
              <option key={zone} value={zone}>
                {zoneLabel(zone)}
              </option>
            ))}
          </select>
        </label>
        {value.map && (modifiers.length > 0 || unavailableModifiers.length > 0) && (
          <fieldset className="rule-chips">
            <legend>Rules</legend>
            <div>
              {modifiers.map((entry) => (
                <label className="rule-chip" key={entry.id}>
                  <input
                    type="checkbox"
                    checked={value.experiences.includes(entry.id)}
                    disabled={disabled || options.loading || !!options.error}
                    onChange={(event) =>
                      change({
                        ...value,
                        experiences: event.target.checked
                          ? [
                              ...(!selectedModes.length && modes.length === 1 ? [modes[0].id] : []),
                              ...value.experiences,
                              entry.id,
                            ]
                          : value.experiences.filter((id) => id !== entry.id),
                      })
                    }
                  />
                  {modeLabel(entry.id, entry.displayName)}
                </label>
              ))}
              {unavailableModifiers.map((id) => (
                <label className="rule-chip" key={id}>
                  <input
                    type="checkbox"
                    checked
                    disabled={disabled}
                    onChange={() =>
                      change({ ...value, experiences: value.experiences.filter((value) => value !== id) })
                    }
                  />
                  Unavailable: {modeLabel(id)}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <label>
          Lighting
          <select
            value={value.lighting ?? ""}
            disabled={disabled}
            onChange={(event) => change({ ...value, lighting: event.target.value || undefined })}
          >
            <option value="">Map default</option>
            {value.lighting && !catalog.lightings.some((entry) => entry.id === value.lighting) && (
              <option value={value.lighting}>Unavailable: {lightingLabel(value.lighting)}</option>
            )}
            {catalog.lightings.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {lightingLabel(entry.id, entry.displayName)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {status && (
        <p className="map-picker-status">
          {status}
          {options.error && (
            <button type="button" className="button secondary small" disabled={disabled} onClick={options.refresh}>
              Retry map options
            </button>
          )}
        </p>
      )}
      {children && (
        <div className="map-picker-footer">
          <div className="map-picker-actions">{children}</div>
          {summary && (
            <span className="map-picker-chip">
              <span className="sr-only">Selected: </span>
              {summary}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
