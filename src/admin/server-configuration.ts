import { z } from "zod";
import {
  settingFields,
  settingValue,
  ROTATION,
  type MapSelection,
  type SettingField,
  type SettingsSnapshot,
  type SettingValue,
} from "../common/server-settings";
import { assertEditable, arrayValue, editConfigKey, scalarValue } from "./config-document";
import type { WardogsClient } from "./wardogs.client";
import { RconError } from "./rcon-protocol";
import { mapLabel, zoneLabel, selectionLabel, sameMap } from "../common/map-labels";
import { serves } from "../common/admin-policy";
import {
  statusSchema,
  mapSelectionSchema,
  type AdminAction,
  type ConfigDocument,
  type Capabilities,
  type ActionResult,
} from "./admin.types";

type ConfigurationAction = Extract<AdminAction, { action: "settings-save" | "rotation-save" | "map-next" }>;
const knownStates = ["live", "applied", "next-match", "next-restart", "pending", "overridden"];
function fieldState(doc: ConfigDocument, field: SettingField) {
  const section = doc.sections?.find(
    (entry) => entry.section.replace(/^\[|\]$/g, "").toLowerCase() === field.section.toLowerCase(),
  );
  const override = section?.keyOverrides?.find((entry) => entry.key.toLowerCase() === field.key.toLowerCase());
  const state = override?.appliesWhen ?? section?.appliesWhen;
  return state && knownStates.includes(state) ? state : "unknown";
}
function readValue(doc: ConfigDocument, field: SettingField): SettingValue | null {
  const raw = scalarValue(doc.text, field.section, field.key);
  if (field.secret || raw === null) return null;
  // Show a saved whole number even when it is outside the range staff may save, so it can be corrected here.
  if (field.type === "number") {
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new Error("The configured value is not a whole number.");
    return Number(raw);
  }
  if (field.type === "boolean") {
    if (!/^(true|false)$/i.test(raw)) throw new Error("The configured value is not a boolean.");
    return raw.toLowerCase() === "true";
  }
  return settingValue(field, raw, true);
}
export function parseRotation(text: string): MapSelection[] {
  return arrayValue(text, ROTATION, "RotationEntries").map((raw) => {
    const outer = raw.match(/^\((.*)\)\s*(?:[;#].*)?$/);
    if (!outer) throw new Error("The rotation uses an unsupported entry. Review it in the host panel.");
    const parts = outer[1].split(/,\s*/);
    const fields = new Map<string, string>();
    for (const part of parts) {
      const match = part.trim().match(/^(Map|Experience|Experiences|Lighting|ZoneAlternator)\s*=\s*"([\w./+-]*)"$/i);
      if (!match || fields.has(match[1].toLowerCase()))
        throw new Error("The rotation contains an unsupported or duplicate field.");
      fields.set(match[1].toLowerCase(), match[2]);
    }
    if (fields.has("experience") && fields.has("experiences"))
      throw new Error("The rotation has ambiguous experiences.");
    return mapSelectionSchema.parse({
      map: fields.get("map"),
      experiences: (fields.get("experiences") ?? fields.get("experience") ?? "").split("+").filter(Boolean),
      ...(fields.get("lighting") ? { lighting: fields.get("lighting") } : {}),
      ...(fields.get("zonealternator") ? { zoneAlternator: fields.get("zonealternator") } : {}),
    });
  });
}
export function formatRotation(entry: MapSelection) {
  return `(${[`Map="${entry.map}"`, `Experiences="${entry.experiences.join("+")}"`, ...(entry.lighting ? [`Lighting="${entry.lighting}"`] : []), ...(entry.zoneAlternator && entry.zoneAlternator !== "None" ? [`ZoneAlternator="${entry.zoneAlternator}"`] : [])].join(",")})`;
}
export class UnavailableSelection extends RconError {}

/** Where a next-round choice ends up; `src/common/voting-policy.ts` mirrors this for the dashboard. */
export type MapNextPlacement = "already-next" | "move" | "swap" | "insert" | "append";
export type MapNextPlan = {
  entries: MapSelection[];
  /** The row the game plays after the running one; `length` when that is unconfirmed after the last row. */
  nextSlot: number;
  /** Where the chosen entry ends up. */
  slot: number;
  placement: MapNextPlacement;
};
/**
 * Places a next-round choice without moving the running row. Live evidence (2 October 2026, c7d2b11)
 * shows the game plays row currentIndex+1. After the last row the game wraps to row 0 only when its
 * status reports `nextIndex` 0. A later copy of the choice is moved up and an earlier copy is swapped
 * into the next slot, so neither grows the rotation. Otherwise the choice is inserted (or appended
 * after the last row when no wrap is confirmed).
 */
export function planMapNext(
  existing: MapSelection[],
  currentIndex: number,
  reportedNextIndex: number | null | undefined,
  entry: MapSelection,
): MapNextPlan {
  const length = existing.length;
  const last = currentIndex >= length - 1;
  const nextSlot = last ? (reportedNextIndex === 0 ? 0 : length) : currentIndex + 1;
  const key = formatRotation(entry);
  const same = (candidate: MapSelection) => formatRotation(candidate) === key;
  const entries = [...existing];
  if (nextSlot < length && same(existing[nextSlot]))
    return { entries, nextSlot, slot: nextSlot, placement: "already-next" };
  // Removing an earlier entry would shift the running numeric index onto another map.
  const later = existing.findIndex((candidate, index) => index > currentIndex && same(candidate));
  if (later >= 0) {
    entries.splice(later, 1);
    entries.splice(currentIndex + 1, 0, entry);
    return { entries, nextSlot, slot: currentIndex + 1, placement: "move" };
  }
  const earlier = existing.findIndex((candidate, index) => index < currentIndex && same(candidate));
  if (earlier >= 0 && nextSlot < length) {
    [entries[earlier], entries[nextSlot]] = [entries[nextSlot], entries[earlier]];
    return { entries, nextSlot, slot: nextSlot, placement: "swap" };
  }
  entries.splice(currentIndex + 1, 0, entry);
  return { entries, nextSlot, slot: currentIndex + 1, placement: last ? "append" : "insert" };
}

export async function validateMapSelection(
  game: WardogsClient,
  selection: MapSelection,
  capabilities: Capabilities,
  catalog?: Awaited<ReturnType<WardogsClient["catalog"]>>,
  reads = new Map<string, Promise<unknown>>(),
) {
  const read = (path: string) => {
    if (!reads.has(path)) reads.set(path, game.request("GET", path));
    return reads.get(path)!;
  };
  const available = catalog ?? (await game.catalog());
  if (
    !available.maps.some((entry) => entry.id === selection.map) ||
    (selection.lighting && !available.lightings.some((entry) => entry.id === selection.lighting)) ||
    selection.experiences.some((id) => !available.experiences.some((entry) => entry.id === id))
  )
    throw new UnavailableSelection("Choose maps, modes and lighting from the current server catalog.");
  if (selection.experiences.length && serves(capabilities, "GET", "/v1/catalog/maps/{map}/experiences")) {
    const result = z
      .object({ experiences: z.array(z.string()) })
      .parse(await read(`/v1/catalog/maps/${encodeURIComponent(selection.map)}/experiences`));
    if (selection.experiences.some((id) => !result.experiences.includes(id)))
      throw new UnavailableSelection("The selected mode is not available for this map.");
  }
  if (selection.zoneAlternator && selection.zoneAlternator !== "None") {
    if (!serves(capabilities, "GET", "/v1/catalog/maps/{map}/alternators"))
      throw new RconError("This server cannot verify the zone layout. Leave it unset.");
    const result = z
      .object({ alternators: z.array(z.object({ tag: z.string() })) })
      .parse(await read(`/v1/catalog/maps/${encodeURIComponent(selection.map)}/alternators`));
    if (!result.alternators.some((entry) => entry.tag === selection.zoneAlternator))
      throw new UnavailableSelection(
        `The zone layout is not available for this map: ${zoneLabel(selection.zoneAlternator)}.`,
      );
  }
}
export async function checkSavedRotation(game: WardogsClient) {
  const doc = await game.document();
  const entries = parseRotation(doc.text);
  if (entries.length > 100)
    throw new RconError("This rotation is too large to check here. Review it in the host panel.");
  const capabilities = await game.capabilities();
  if (!["maps", "lightings", "experiences"].every((kind) => serves(capabilities, "GET", `/v1/catalog/${kind}`)))
    throw new RconError("This build does not expose the catalogs needed to check the saved rotation.");
  const catalog = await game.catalog();
  const reads = new Map<string, Promise<unknown>>();
  const issues: { index: number; message: string; unavailable: boolean }[] = [];
  for (const [index, entry] of entries.entries()) {
    try {
      await validateMapSelection(game, entry, capabilities, catalog, reads);
    } catch (error) {
      const unavailable = error instanceof UnavailableSelection;
      issues.push({
        index,
        unavailable,
        message: unavailable
          ? `${mapLabel(entry.map)}: ${error.message}`
          : `${mapLabel(entry.map)}: Options could not be verified. Try checking again.`,
      });
    }
  }
  return { revision: doc.revision, total: entries.length, issues };
}
// RconError text is written for staff and never forwards upstream bodies; a format
// mismatch names only the field, so staff can report what the game changed.
function rotationReadFailure(error: unknown) {
  if (error instanceof RconError) return error.message;
  if (!(error instanceof z.ZodError)) return "Refresh to try again.";
  const [issue] = error.issues;
  const field = issue.path.map((part) => (typeof part === "number" ? `#${part + 1}` : String(part))).join(" ");
  const more = error.issues.length > 1 ? `; ${error.issues.length - 1} more` : "";
  return `The game's reply was not in the expected format (${field || "reply"}: ${issue.message}${more}). Refresh to try again.`;
}
/**
 * `nextIndex` is the entry played after this match: the one after the running entry, or the
 * game's own next entry when it names no running entry. Only a running entry allows queuing.
 */
async function rotationPosition(
  game: WardogsClient,
  status: z.infer<typeof statusSchema> | null,
  entries: MapSelection[],
  doc: ConfigDocument,
  capabilities: Capabilities,
): Promise<{ currentIndex: number | null; nextIndex: number | null; positionNote: string }> {
  const unavailable = (positionNote: string) => ({ currentIndex: null, nextIndex: null, positionNote });
  const confirmed = (index: number) => ({ currentIndex: index, nextIndex: index + 1, positionNote: "" });
  if (!status) return unavailable("The running map could not be read. Refresh to try again.");
  const mapMismatch = (index: number, map: string) =>
    unavailable(
      `Rotation entry ${index + 1} is ${mapLabel(map)}, but ${mapLabel(status.map)} is running. Refresh to check again.`,
    );
  const index = status.rotation?.nowIndex;
  if (index !== undefined && index !== null && index !== -1) {
    if (!Number.isSafeInteger(index) || index < 0 || !entries[index])
      return unavailable(
        `The game reports a position outside the ${entries.length} saved rotation entries. Refresh to check again.`,
      );
    return sameMap(entries[index].map, status.map) ? confirmed(index) : mapMismatch(index, entries[index].map);
  }
  if (!serves(capabilities, "GET", "/v1/rotation"))
    return unavailable("The game has not supplied its place in the rotation. Refresh after the next round starts.");
  try {
    // The official console uses the rotation's `now` marker when status has no index.
    // Match the ordered rows, not just the map name: a map may appear more than once.
    // Both positions below are numeric, so the running rows must match the saved rows first.
    const running = await game.rotation();
    if (
      running.enabled !== (scalarValue(doc.text, ROTATION, "bEnabled")?.toLowerCase() === "true") ||
      running.mode.toLowerCase() !== scalarValue(doc.text, ROTATION, "RotationMode")?.toLowerCase()
    )
      return unavailable(
        "The running rotation's enabled state or order differs from the saved settings. Refresh to check again.",
      );
    if (running.entries.length !== entries.length)
      return unavailable(
        `The running rotation has ${running.entries.length} entries; the saved rotation has ${entries.length}. Refresh to check again.`,
      );
    for (const [i, entry] of running.entries.entries()) {
      const saved = entries[i];
      if (entry.index !== i)
        return unavailable("The game returned inconsistent rotation entry numbers. Refresh to check again.");
      if (
        !sameMap(entry.map, saved.map) ||
        (saved.experiences.length > 0 &&
          JSON.stringify([...saved.experiences].sort()) !== JSON.stringify([...(entry.experiences ?? [])].sort())) ||
        (!!saved.lighting && saved.lighting !== entry.lighting) ||
        (!!saved.zoneAlternator && saved.zoneAlternator !== "None" && saved.zoneAlternator !== entry.zoneAlternator)
      )
        return unavailable(
          `Rotation entry ${i + 1} differs. Running: ${selectionLabel({ ...entry, experiences: entry.experiences ?? [] })}. Saved: ${selectionLabel(saved)}. Refresh to check again.`,
        );
    }
    const marked = (marker: string) => running.entries.flatMap((entry, i) => (entry.status === marker ? [i] : []));
    const now = marked("now");
    if (now.length === 1) {
      if (!sameMap(running.entries[now[0]].map, status.map)) return mapMismatch(now[0], running.entries[now[0]].map);
      if (running.entries[now[0]].denied)
        return unavailable(`The game marks current rotation entry ${now[0] + 1} unavailable. Refresh to check again.`);
      return confirmed(now[0]);
    }
    // With no running entry named (for example after a direct map change), the game keeps its
    // own next entry: on October 2 a row inserted before it was skipped and the game moved its
    // pointer from entry 1 to 2. Show that entry, but queue only once a rotation round runs.
    const next = status.rotation?.nextIndex;
    if (
      now.length === 0 &&
      typeof next === "number" &&
      Number.isSafeInteger(next) &&
      next >= 0 &&
      next < entries.length &&
      marked("next").every((i) => i === next)
    )
      return {
        currentIndex: null,
        nextIndex: next,
        positionNote: `This match was not started from the rotation, so the game will play entry ${next + 1} next. Queue a map once that round starts.`,
      };
    return unavailable(
      "The game has not identified one current or next rotation entry. Refresh after the next round starts.",
    );
  } catch (error) {
    return unavailable(`The running rotation could not be read. ${rotationReadFailure(error)}`);
  }
}
export async function readServerConfiguration(game: WardogsClient): Promise<SettingsSnapshot> {
  const capabilities = await game.capabilities();
  const doc = await game.document();
  const writable = doc.writable && capabilities.config?.writable !== false && serves(capabilities, "PUT", "/v1/config");
  // A status outage does not hide the stored configuration. Scoring edits need a fresh range at write time.
  let status: z.infer<typeof statusSchema> | null = null;
  try {
    status = statusSchema.parse(await game.request("GET", "/v1/status"));
  } catch {
    /* unavailable, never fabricate current values */
  }
  const fields = settingFields.map((field) => {
    let value: SettingValue | null = null,
      editable = writable,
      note = "";
    try {
      value = readValue(doc, field);
    } catch {
      editable = false;
      note = "Value unavailable or ambiguous. Check the host panel.";
    }
    try {
      assertEditable(doc, field.section, field.key);
    } catch (error) {
      editable = false;
      note = (error as Error).message;
    }
    if (field.id === "scorePeriod" && !status?.scoreTick) {
      editable = false;
      note = "The server has not supplied its scoring range.";
    }
    return { id: field.id, value, editable, note, state: fieldState(doc, field) };
  });
  let entries: MapSelection[] = [],
    rotationEditable = writable,
    rotationNote = "";
  try {
    entries = parseRotation(doc.text);
    assertEditable(doc, ROTATION, "RotationEntries");
  } catch {
    rotationEditable = false;
    rotationNote = "Rotation is unavailable, locked or uses an unsupported format. Check the host panel.";
  }
  return {
    revision: doc.revision,
    writable,
    notice: writable ? "" : "Configuration is read-only on this server.",
    fields,
    scoreTick: status?.scoreTick ?? null,
    rotation: {
      entries,
      editable: rotationEditable,
      note: rotationNote,
      ...(await rotationPosition(game, status, entries, doc, capabilities)),
      currentMap: status?.map ?? "",
      enabled: fields.find((f) => f.id === "rotationEnabled")?.value === true,
      mode: String(fields.find((f) => f.id === "rotationMode")?.value ?? ""),
    },
  };
}
export async function changeServerConfiguration(
  game: WardogsClient,
  action: ConfigurationAction,
  capabilities: Capabilities,
): Promise<ActionResult> {
  const doc = await game.document();
  if (doc.revision !== action.revision)
    throw new RconError("Settings changed since you opened this page. Reload and review your changes.");
  let text = doc.text;
  try {
    if (action.action === "settings-save") {
      for (const [id, input] of Object.entries(action.changes)) {
        const field = settingFields.find((entry) => entry.id === id);
        if (!field) throw new RconError("An unknown setting was submitted.");
        const value = settingValue(field, input);
        if (id === "scorePeriod") {
          const status = statusSchema.parse(await game.request("GET", "/v1/status"));
          if (!status.scoreTick || Number(value) < status.scoreTick.min || Number(value) > status.scoreTick.max)
            throw new RconError("Choose a scoring interval within the server’s current range.");
        }
        text = editConfigKey(
          { ...doc, text },
          field.section,
          field.key,
          typeof value === "string"
            ? `"${value}"`
            : typeof value === "boolean"
              ? value
                ? "True"
                : "False"
              : String(value),
        );
      }
      for (const [minId, maxId] of [
        ["minPlayerCash", "maxPlayerCash"],
        ["minPlayerLevel", "maxPlayerLevel"],
      ]) {
        if (!(minId in action.changes) && !(maxId in action.changes)) continue;
        const minimum = readValue({ ...doc, text }, settingFields.find((field) => field.id === minId)!);
        const maximum = readValue({ ...doc, text }, settingFields.find((field) => field.id === maxId)!);
        if (minimum !== null && maximum !== null && Number(maximum) !== 0 && Number(minimum) > Number(maximum))
          throw new RconError("A joining minimum cannot exceed its maximum.");
      }
    } else {
      // Always parse the old list first; do not silently discard unsupported fields.
      const existing = parseRotation(doc.text);
      let entries: MapSelection[];
      let placedAt = 0;
      if (action.action === "map-next") {
        const status = statusSchema.parse(await game.request("GET", "/v1/status"));
        const position = await rotationPosition(game, status, existing, doc, capabilities);
        if (position.currentIndex === null) throw new RconError(position.positionNote);
        if (position.currentIndex !== action.currentIndex || !sameMap(status.map, action.currentMap))
          throw new RconError("The current round changed. Reload before queuing a map.");
        if (
          scalarValue(doc.text, ROTATION, "bEnabled")?.toLowerCase() !== "true" ||
          scalarValue(doc.text, ROTATION, "RotationMode")?.toLowerCase() !== "ordered"
        )
          throw new RconError("Enable an ordered rotation before choosing the next map.");
        if (!existing[action.currentIndex] || !sameMap(existing[action.currentIndex].map, status.map))
          throw new RconError("The running map does not match the saved rotation. Reload and review it.");
        const plan = planMapNext(existing, action.currentIndex, status.rotation?.nextIndex, action.entry);
        if (action.nextSlot !== undefined && plan.nextSlot !== action.nextSlot)
          throw new RconError(
            "The game no longer reports the next rotation entry this choice was planned for. Nothing was changed.",
          );
        // Rewriting an unchanged list would still change the saved array syntax; send nothing.
        if (plan.placement === "already-next")
          return {
            state: "applied",
            revision: doc.revision,
            changed: false,
            message: "This entry is already next in the rotation. No change was sent.",
          };
        entries = plan.entries;
        placedAt = plan.slot;
      } else entries = action.entries;
      if (entries.length > 100) throw new RconError("Keep the rotation to 100 entries or fewer.");
      const catalog = await game.catalog();
      const reads = new Map<string, Promise<unknown>>();
      // A next-round choice preserves the other saved entries. Old catalog values
      // elsewhere must not prevent a valid choice; native validation still checks
      // the complete document before any conditional write.
      const selections = action.action === "map-next" ? [[placedAt, action.entry] as const] : entries.entries();
      for (const [index, entry] of selections) {
        try {
          await validateMapSelection(game, entry, capabilities, catalog, reads);
        } catch (error) {
          if (error instanceof RconError)
            throw new RconError(`Entry ${index + 1} (${mapLabel(entry.map)}): ${error.message}`);
          throw error;
        }
      }
      text = editConfigKey(doc, ROTATION, "RotationEntries", entries.map(formatRotation));
    }
  } catch (error) {
    if (error instanceof RconError) throw error;
    // Only locally authored validation errors may reach browsers; never forward a raw document or upstream error.
    if (error instanceof z.ZodError) throw new RconError("The server returned an unsupported settings format.");
    throw new RconError(error instanceof Error ? error.message : "The settings could not be validated.");
  }
  if (text === doc.text)
    return {
      state: "applied",
      revision: doc.revision,
      changed: false,
      message: "These settings are already saved. No change was sent.",
    };
  const result = await game.writeDocument(doc, text, capabilities);
  let revision: string | undefined;
  try {
    const saved = await game.document();
    const confirmed =
      action.action === "settings-save"
        ? Object.entries(action.changes).every(([id]) => {
            const field = settingFields.find((entry) => entry.id === id)!;
            return scalarValue(saved.text, field.section, field.key) === scalarValue(text, field.section, field.key);
          })
        : JSON.stringify(parseRotation(saved.text)) === JSON.stringify(parseRotation(text));
    if (!confirmed)
      return { state: "unknown", message: "The saved values did not match. Refresh and review before trying again." };
    if (saved.text === text) revision = saved.revision;
  } catch {
    return {
      state: "unknown",
      message: "The request was accepted, but saved values could not be verified. Refresh before trying again.",
    };
  }
  const outcomes = Array.isArray(result.outcomes) ? result.outcomes : [];
  const labels: Record<string, string> = {
    "next-match": "Some changes take effect next match.",
    "next-restart": "Some changes require a server restart.",
    pending: "Some changes are still being checked.",
    overridden: "Some values are overridden by the host.",
  };
  const notes = [
    ...new Set<string>(outcomes.map((outcome: { state?: string }) => labels[outcome.state ?? ""]).filter(Boolean)),
  ];
  if (Array.isArray(result.shadowed) && result.shadowed.length) notes.push("Some values are overridden by the host.");
  // Saved does not establish that gameplay has already adopted the new values.
  return {
    state: "pending",
    ...(revision ? { revision } : {}),
    message: `Settings saved and verified. ${notes.join(" ") || "Check the running game to confirm when they take effect."}`,
  };
}

export function auditAction(action: AdminAction): AdminAction {
  return action.action === "settings-save" && "serverPassword" in action.changes
    ? { ...action, changes: { ...action.changes, serverPassword: "[redacted]" } }
    : action;
}
