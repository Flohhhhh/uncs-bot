"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";

import type { MatchCatalog, MatchMapOptions, MatchSelection } from "./match-data";

type ChoiceOption = { value: string; label: string };
type ChoiceFieldData = {
  label: string;
  value: string;
  placeholder: string;
  options: ChoiceOption[];
  disabled: boolean;
  defaultOption?: boolean;
  change: (value: string) => void;
};

function selectionFields({
  catalog,
  options,
  value,
  onChange,
  disabled,
  optionsLoading,
  optionsError,
}: {
  catalog: MatchCatalog;
  options?: MatchMapOptions;
  value: MatchSelection;
  onChange: (value: MatchSelection) => void;
  disabled: boolean;
  optionsLoading: boolean;
  optionsError: boolean;
}): ChoiceFieldData[] {
  return [
    {
      label: "Map",
      value: value.map,
      placeholder: "Choose a map",
      options: catalog.maps.map((map) => ({ value: map.id, label: map.displayName || map.id })),
      disabled,
      change: (map) => onChange({ map, experiences: [], zoneAlternator: undefined }),
    },
    {
      label: "Game mode",
      value: value.experiences[0] ?? "",
      placeholder: "Map default",
      options: (options?.experiences ?? []).map((experience) => ({
        value: experience.id,
        label: experience.displayName || experience.id,
      })),
      defaultOption: true,
      disabled: disabled || !value.map || optionsLoading || optionsError,
      change: (experience) => onChange({ ...value, experiences: experience ? [experience] : [] }),
    },
    {
      label: "Zone layout",
      value: value.zoneAlternator ?? "",
      placeholder: "Map default",
      options: (options?.zones ?? []).map((zone) => ({
        value: zone,
        label: zone
          .replace(/^ZoneAlternator\.[^.]+\./, "")
          .replace(/\.Circle$/, "")
          .replace(/([a-z])([A-Z])/g, "$1 $2"),
      })),
      defaultOption: true,
      disabled: disabled || !value.map || optionsLoading || optionsError || !options?.zones,
      change: (zone) => onChange({ ...value, zoneAlternator: zone || undefined }),
    },
    {
      label: "Lighting",
      value: value.lighting ?? "",
      placeholder: "Map default",
      options: catalog.lightings.map((lighting) => ({
        value: lighting.id,
        label: lighting.displayName || lighting.id,
      })),
      defaultOption: true,
      disabled,
      change: (lighting) => onChange({ ...value, lighting: lighting || undefined }),
    },
  ];
}

export function MatchSelectionFields({
  catalog,
  options,
  value,
  onChange,
  disabled = false,
  optionsLoading = false,
  optionsError = false,
}: {
  catalog: MatchCatalog;
  options?: MatchMapOptions;
  value: MatchSelection;
  onChange: (value: MatchSelection) => void;
  disabled?: boolean;
  optionsLoading?: boolean;
  optionsError?: boolean;
}) {
  const fields = selectionFields({ catalog, options, value, onChange, disabled, optionsLoading, optionsError });

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {fields.map((field) => (
        <ChoiceField key={field.label} {...field} />
      ))}
      {optionsError ? (
        <p className="self-end text-sm text-destructive">Map options could not be loaded. Refresh before queuing.</p>
      ) : optionsLoading && value.map ? (
        <p className="self-end text-sm text-muted-foreground">Loading map options…</p>
      ) : null}
    </div>
  );
}

function ChoiceField({ label, value, placeholder, options, disabled, defaultOption = false, change }: ChoiceFieldData) {
  const selected = defaultOption ? value || "default" : value;
  return (
    <label className="grid min-w-0 gap-2 text-sm font-medium">
      {label}
      <Select
        value={selected}
        onValueChange={(next) => change(defaultOption && next === "default" ? "" : next)}
        disabled={disabled}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {defaultOption ? <SelectItem value="default">{placeholder}</SelectItem> : null}
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
