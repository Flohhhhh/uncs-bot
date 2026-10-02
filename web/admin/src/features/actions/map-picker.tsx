import type { MapSelection } from "../../../../../src/common/server-settings";
import { mapLabel, modeLabel, lightingLabel, zoneLabel, isModeModifier } from "../../../../../src/common/map-labels";
import type { Catalog } from "../../api/types";
import { useResource } from "../../api/use-resource";
import { useEffect } from "react";
export function MapPicker({
  value,
  change,
  catalog,
  disabled = false,
  onReadyChange,
}: {
  value: MapSelection;
  change: (value: MapSelection) => void;
  catalog: Catalog;
  disabled?: boolean;
  onReadyChange?: (ready: boolean) => void;
}) {
  const options = useResource<{ experiences: Catalog["experiences"]; zones: string[] | null }>(
    value.map ? `catalog/maps/${encodeURIComponent(value.map)}` : null,
  );
  const modes = (options.data?.experiences ?? []).filter((entry) => !isModeModifier(entry.id));
  const modifiers = (options.data?.experiences ?? []).filter((entry) => isModeModifier(entry.id));
  const selectedModes = value.experiences.filter((id) => !isModeModifier(id));
  const unavailableModes =
    options.data && !options.loading && !options.error
      ? value.experiences.filter((id) => !options.data!.experiences.some((entry) => entry.id === id))
      : [];
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
  return (
    <div className="settings-grid">
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
        {selectedModes.length > 1 && <small>Choose one game mode. Your saved selection contains more than one.</small>}
      </label>
      <fieldset className="mode-choices">
        <legend>Rules</legend>
        {modifiers.map((entry) => (
          <label key={entry.id}>
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
        {unavailableModes.filter(isModeModifier).map((id) => (
          <label key={id}>
            <input
              type="checkbox"
              checked
              disabled={disabled}
              onChange={() => change({ ...value, experiences: value.experiences.filter((value) => value !== id) })}
            />
            Unavailable: {modeLabel(id)}
          </label>
        ))}
        <small>Leave both off for normal rules. Infantry only and Hardcore can be combined.</small>
        <small>
          {options.error ||
            (value.map
              ? options.loading
                ? "Loading map options…"
                : "Only options advertised by this server."
              : "Choose a map to see its modes.")}
        </small>
        {options.error && (
          <button type="button" className="button secondary" disabled={disabled} onClick={options.refresh}>
            Retry map options
          </button>
        )}
      </fieldset>
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
        <small>
          {!value.map
            ? "Choose a map to see its zone layouts."
            : options.loading
              ? "Loading zone layouts…"
              : options.error
                ? "Zone layouts could not be checked."
                : savedZoneMissing && options.data?.zones
                  ? "This saved layout is not in the current catalog. Choose another layout before saving."
                  : options.data?.zones
                    ? "Choose a control-zone layout."
                    : "This server has not supplied zone layouts."}
        </small>
      </label>
    </div>
  );
}
