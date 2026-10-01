import type { MapSelection } from "../../../../../src/common/server-settings";
import type { Catalog } from "../../api/types";
import { useResource } from "../../api/use-resource";
export function MapPicker({
  value,
  change,
  catalog,
  disabled = false,
}: {
  value: MapSelection;
  change: (value: MapSelection) => void;
  catalog: Catalog;
  disabled?: boolean;
}) {
  const options = useResource<{ experiences: Catalog["experiences"]; zones: string[] | null }>(
    value.map ? `catalog/maps/${encodeURIComponent(value.map)}` : null,
  );
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
          {catalog.maps.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.displayName || entry.id}
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
          {catalog.lightings.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.displayName || entry.id}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="mode-choices">
        <legend>Modes & modifiers</legend>
        {(options.data?.experiences ?? []).map((entry) => (
          <label key={entry.id}>
            <input
              type="checkbox"
              checked={value.experiences.includes(entry.id)}
              disabled={
                disabled || !!options.error || (!value.experiences.includes(entry.id) && value.experiences.length >= 10)
              }
              onChange={(event) =>
                change({
                  ...value,
                  experiences: event.target.checked
                    ? [...value.experiences, entry.id]
                    : value.experiences.filter((id) => id !== entry.id),
                })
              }
            />
            {entry.displayName || entry.id}
          </label>
        ))}
        <small>
          {options.error || (value.map ? "Only options advertised by this server." : "Choose a map to see its modes.")}
        </small>
      </fieldset>
      <label>
        Zone layout
        <select
          value={value.zoneAlternator ?? ""}
          disabled={disabled || !options.data?.zones || !!options.error}
          onChange={(event) => change({ ...value, zoneAlternator: event.target.value || undefined })}
        >
          <option value="">Map default</option>
          {options.data?.zones?.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
        <small>
          {options.data?.zones ? "Choose a control-zone layout." : "This server has not supplied zone layouts."}
        </small>
      </label>
    </div>
  );
}
