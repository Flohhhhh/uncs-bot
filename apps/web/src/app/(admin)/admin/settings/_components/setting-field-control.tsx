"use client";

import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";

import {
  displaySettingValue,
  timingLabel,
  timingSymbol,
  type SettingField,
  type SettingValue,
  type SettingsSnapshot,
} from "./settings-data";

export function SettingFieldControl({
  field,
  snapshot,
  observed,
  value,
  changed,
  locked,
  removing,
  onUpdate,
  onClearPassword,
}: {
  field: SettingField;
  snapshot: SettingsSnapshot;
  observed?: SettingsSnapshot["fields"][number];
  value: SettingValue;
  changed: boolean;
  locked: boolean;
  removing: boolean;
  onUpdate: (id: string, value: SettingValue, clearPassword?: boolean) => void;
  onClearPassword: (id: string) => void;
}) {
  const controlId = `setting-${field.id}`;
  const helpId = `${controlId}-help`;
  const editable = Boolean(observed?.editable && !locked);
  const numberValue = typeof value === "number" ? value : "";
  const scoreRange = field.id === "scorePeriod" ? snapshot.scoreTick : null;

  function updateNumber(next: string) {
    onUpdate(field.id, next === "" ? "" : Number(next));
  }

  let control;
  if (field.type === "boolean") {
    control = (
      <div className="flex items-center gap-3">
        <label htmlFor={controlId} className="relative inline-flex h-6 w-11 cursor-pointer items-center">
          <input
            id={controlId}
            type="checkbox"
            role="switch"
            aria-label={field.label}
            aria-describedby={helpId}
            checked={value === true}
            disabled={!editable}
            className="peer sr-only"
            onChange={(event) => onUpdate(field.id, event.currentTarget.checked)}
          />
          <span className="absolute inset-0 rounded-full bg-muted-foreground/30 transition-colors peer-checked:bg-orange-500 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-disabled:cursor-not-allowed peer-disabled:opacity-50" />
          <span className="absolute left-0.5 size-5 rounded-full bg-background shadow transition-transform peer-checked:translate-x-5" />
        </label>
        <span className="text-sm text-muted-foreground">
          {typeof value === "boolean" ? (value ? "On" : "Off") : "Not set in file"}
        </span>
      </div>
    );
  } else if (field.type === "select") {
    control = (
      <Select value={String(value)} onValueChange={(next) => onUpdate(field.id, next)} disabled={!editable}>
        <SelectTrigger id={controlId} aria-describedby={helpId} className="w-full">
          <SelectValue placeholder="Not set in file" />
        </SelectTrigger>
        <SelectContent>
          {(field.options ?? []).map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (scoreRange) {
    const sliderValue = Math.max(
      scoreRange.min,
      Math.min(scoreRange.max, typeof value === "number" ? value : scoreRange.current),
    );
    control = (
      <div className="grid grid-cols-[minmax(0,1fr)_7rem_auto] items-center gap-3">
        <input
          type="range"
          aria-label="Scoring interval slider"
          aria-describedby={helpId}
          min={scoreRange.min}
          max={scoreRange.max}
          step={1}
          value={sliderValue}
          aria-valuetext={`${sliderValue} seconds`}
          disabled={!editable}
          className="h-2 w-full cursor-pointer accent-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
          onChange={(event) => onUpdate(field.id, Number(event.currentTarget.value))}
        />
        <Input
          id={controlId}
          type="number"
          min={scoreRange.min}
          max={scoreRange.max}
          step={1}
          aria-describedby={helpId}
          value={numberValue}
          disabled={!editable}
          onChange={(event) => updateNumber(event.currentTarget.value)}
        />
        <span aria-hidden="true" className="text-sm text-muted-foreground">
          s
        </span>
      </div>
    );
  } else {
    control = (
      <Input
        id={controlId}
        type={
          field.type === "password"
            ? "password"
            : field.type === "number"
              ? "number"
              : field.type === "url"
                ? "url"
                : "text"
        }
        autoComplete={field.secret ? "new-password" : "off"}
        value={field.type === "number" ? numberValue : String(value)}
        placeholder={field.secret ? (removing ? "Password will be removed" : "Leave unchanged") : "Not set in file"}
        disabled={!editable}
        min={field.min}
        max={field.max}
        maxLength={field.type !== "number" ? field.max : undefined}
        step={field.type === "number" ? 1 : undefined}
        aria-describedby={helpId}
        onChange={(event) =>
          onUpdate(
            field.id,
            field.type === "number"
              ? event.currentTarget.value === ""
                ? ""
                : Number(event.currentTarget.value)
              : event.currentTarget.value,
          )
        }
      />
    );
  }

  return (
    <div
      className={`grid min-w-0 gap-3 rounded-md border p-4 transition-colors ${changed ? "border-orange-500/50 bg-orange-500/5" : "bg-background/30"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {field.type === "boolean" ? (
          <span className="text-sm font-semibold">{field.label}</span>
        ) : (
          <label htmlFor={controlId} className="text-sm font-semibold">
            {field.label}
          </label>
        )}
        <Badge variant="outline" className="gap-1.5 text-xs font-normal text-muted-foreground">
          {observed?.editable && timingSymbol(observed.state) ? (
            <span aria-hidden="true">{timingSymbol(observed.state)}</span>
          ) : null}
          {observed?.editable ? timingLabel(observed.state) : "Read-only"}
        </Badge>
        {changed && !field.secret && observed ? (
          <span className="basis-full text-xs text-muted-foreground">
            Saved value: {displaySettingValue(field, observed.value)}
          </span>
        ) : null}
      </div>
      {control}
      <p id={helpId} className="text-sm text-muted-foreground">
        {observed?.note || field.help}
      </p>
      {field.id === "scorePeriod" && snapshot.scoreTick ? (
        <p className="text-xs text-muted-foreground">
          Running: {snapshot.scoreTick.current}s · Allowed: {snapshot.scoreTick.min}–{snapshot.scoreTick.max}s
        </p>
      ) : null}
      {field.secret ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="text-sm font-medium text-orange-400 underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!editable}
            onClick={() => (removing ? onUpdate(field.id, "") : onClearPassword(field.id))}
          >
            {removing ? "Undo clear password" : "Clear join password"}
          </button>
          {removing ? (
            <span role="status" className="text-xs text-muted-foreground">
              Join password will be removed on save.
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
