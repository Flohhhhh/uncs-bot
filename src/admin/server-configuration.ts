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
  if (field.type === "number") return settingValue(field, /^\d+$/.test(raw) ? Number(raw) : NaN);
  if (field.type === "boolean") {
    if (!/^(true|false)$/i.test(raw)) throw new Error("The configured value is not a boolean.");
    return raw.toLowerCase() === "true";
  }
  return settingValue(field, raw);
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
export async function validateMapSelection(
  game: WardogsClient,
  selection: MapSelection,
  capabilities: Capabilities,
  catalog?: Awaited<ReturnType<WardogsClient["catalog"]>>,
) {
  const available = catalog ?? (await game.catalog());
  if (
    !available.maps.some((entry) => entry.id === selection.map) ||
    (selection.lighting && !available.lightings.some((entry) => entry.id === selection.lighting)) ||
    selection.experiences.some((id) => !available.experiences.some((entry) => entry.id === id))
  )
    throw new RconError("Choose maps, modes and lighting from the current server catalog.");
  if (selection.experiences.length && serves(capabilities, "GET", "/v1/catalog/maps/{map}/experiences")) {
    const result = z
      .object({ experiences: z.array(z.string()) })
      .parse(await game.request("GET", `/v1/catalog/maps/${encodeURIComponent(selection.map)}/experiences`));
    if (selection.experiences.some((id) => !result.experiences.includes(id)))
      throw new RconError("The selected mode is not available for this map.");
  }
  if (selection.zoneAlternator && selection.zoneAlternator !== "None") {
    if (!serves(capabilities, "GET", "/v1/catalog/maps/{map}/alternators"))
      throw new RconError("This server cannot verify the zone layout. Leave it unset.");
    const result = z
      .object({ alternators: z.array(z.object({ tag: z.string() })) })
      .parse(await game.request("GET", `/v1/catalog/maps/${encodeURIComponent(selection.map)}/alternators`));
    if (!result.alternators.some((entry) => entry.tag === selection.zoneAlternator))
      throw new RconError("The zone layout is not available for this map.");
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
      currentIndex: status?.rotation?.nowIndex ?? null,
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
      if (action.action === "map-next") {
        const status = statusSchema.parse(await game.request("GET", "/v1/status"));
        if (status.rotation?.nowIndex !== action.currentIndex || status.map !== action.currentMap)
          throw new RconError("The current round changed. Reload before queuing a map.");
        if (
          scalarValue(doc.text, ROTATION, "bEnabled")?.toLowerCase() !== "true" ||
          scalarValue(doc.text, ROTATION, "RotationMode")?.toLowerCase() !== "ordered"
        )
          throw new RconError("Enable an ordered rotation before choosing the next map.");
        if (!existing[action.currentIndex] || existing[action.currentIndex].map !== status.map)
          throw new RconError("The running map does not match the saved rotation. Reload and review it.");
        entries = [...existing];
        const match = entries.findIndex(
          (entry, index) => index !== action.currentIndex && formatRotation(entry) === formatRotation(action.entry),
        );
        let current = action.currentIndex;
        if (match >= 0) {
          entries.splice(match, 1);
          if (match < current) current--;
        }
        entries.splice(current + 1, 0, action.entry);
      } else entries = action.entries;
      if (entries.length > 100) throw new RconError("Keep the rotation to 100 entries or fewer.");
      const catalog = await game.catalog();
      for (const entry of entries) await validateMapSelection(game, entry, capabilities, catalog);
      text = editConfigKey(doc, ROTATION, "RotationEntries", entries.map(formatRotation));
    }
  } catch (error) {
    if (error instanceof RconError) throw error;
    // Only locally authored validation errors may reach browsers; never forward a raw document or upstream error.
    if (error instanceof z.ZodError) throw new RconError("The server returned an unsupported settings format.");
    throw new RconError(error instanceof Error ? error.message : "The settings could not be validated.");
  }
  if (text === doc.text) return { state: "applied", message: "These settings are already saved. No change was sent." };
  const result = await game.writeDocument(doc, text, capabilities);
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
    message: `Settings saved and verified. ${notes.join(" ") || "Check the running game to confirm when they take effect."}`,
  };
}

export function auditAction(action: AdminAction): AdminAction {
  return action.action === "settings-save" && "serverPassword" in action.changes
    ? { ...action, changes: { ...action.changes, serverPassword: "[redacted]" } }
    : action;
}
