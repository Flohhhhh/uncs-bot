import { z } from "zod";

export type SettingValue = string | number | boolean;
export type SettingGroup = "Identity" | "Joining" | "Gameplay" | "Rotation" | "Host controls";
export type SettingField = {
  id: string;
  label: string;
  group: Exclude<SettingGroup, "Host controls">;
  type: "text" | "number" | "boolean" | "select" | "url" | "password";
  help: string;
  min?: number;
  max?: number;
  options?: readonly string[];
  secret?: boolean;
};

export const settingGroups: readonly SettingGroup[] = ["Identity", "Joining", "Gameplay", "Rotation", "Host controls"];

export const settingFields: readonly SettingField[] = [
  {
    id: "serverName",
    label: "Server name",
    group: "Identity",
    type: "text",
    max: 64,
    help: "Name shown in the game’s server browser.",
  },
  {
    id: "imageUrl",
    label: "Server banner URL",
    group: "Identity",
    type: "url",
    max: 2048,
    help: "1024 × 256 PNG or JPEG on a host allowed by the game. The game validates the image.",
  },
  {
    id: "serverPassword",
    label: "Join password",
    group: "Joining",
    type: "password",
    secret: true,
    max: 128,
    help: "Enter a replacement, or clear it to open the server. The existing password is never displayed.",
  },
  {
    id: "maxPlayers",
    label: "Player capacity",
    group: "Joining",
    type: "number",
    min: 1,
    help: "Includes reserved slots; the game enforces the host’s capacity limits.",
  },
  {
    id: "maxReservedSlots",
    label: "Reserved-slot capacity",
    group: "Joining",
    type: "number",
    min: 0,
    help: "Changes capacity only. Manage individual players under Whitelist.",
  },
  {
    id: "minPlayerCash",
    label: "Minimum player cash",
    group: "Joining",
    type: "number",
    min: 0,
    help: "0 removes this joining restriction.",
  },
  {
    id: "maxPlayerCash",
    label: "Maximum player cash",
    group: "Joining",
    type: "number",
    min: 0,
    help: "0 removes this joining restriction.",
  },
  {
    id: "minPlayerLevel",
    label: "Minimum player level",
    group: "Joining",
    type: "number",
    min: 0,
    help: "0 removes this joining restriction.",
  },
  {
    id: "maxPlayerLevel",
    label: "Maximum player level",
    group: "Joining",
    type: "number",
    min: 0,
    help: "0 removes this joining restriction.",
  },
  {
    id: "minRequiredPlayers",
    label: "Players to start a match",
    group: "Gameplay",
    type: "number",
    min: 20,
    help: "The game will not start a match with fewer than 20 players.",
  },
  {
    id: "scorePeriod",
    label: "Scoring interval (seconds)",
    group: "Gameplay",
    type: "number",
    min: 1,
    help: "Seconds between scoring ticks. Faster ticks pay less per tick; the server supplies the allowed range.",
  },
  {
    id: "lockOverpopulated",
    label: "Lock overpopulated teams",
    group: "Gameplay",
    type: "boolean",
    help: "Prevent joining a team that exceeds the population threshold.",
  },
  {
    id: "overpopThreshold",
    label: "Team population threshold",
    group: "Gameplay",
    type: "number",
    min: 0,
    help: "How many players ahead a team can be before it locks.",
  },
  {
    id: "rotationEnabled",
    label: "Enable map rotation",
    group: "Rotation",
    type: "boolean",
    help: "Advance through the rotation after each match.",
  },
  {
    id: "rotationMode",
    label: "Rotation order",
    group: "Rotation",
    type: "select",
    options: ["Ordered", "Random"],
    help: "A queued next map requires an enabled, ordered rotation.",
  },
];

export const settingFieldById = Object.fromEntries(settingFields.map((field) => [field.id, field])) as Record<
  string,
  SettingField
>;

const valueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const fieldSchema = z.object({
  id: z.string(),
  value: valueSchema.nullable(),
  editable: z.boolean(),
  note: z.string(),
  state: z.string(),
});

export const settingsSnapshotSchema = z.object({
  revision: z.string(),
  writable: z.boolean(),
  notice: z.string(),
  fields: z.array(fieldSchema),
  scoreTick: z.object({ current: z.number(), min: z.number(), max: z.number() }).nullable(),
  rotation: z.object({
    entries: z.array(
      z.object({
        map: z.string(),
        experiences: z.array(z.string()),
        lighting: z.string().optional(),
        zoneAlternator: z.string().optional(),
      }),
    ),
    editable: z.boolean(),
    note: z.string(),
    currentIndex: z.number().int().nullable(),
    nextIndex: z.number().int().nullable(),
    positionNote: z.string().optional(),
    currentMap: z.string(),
    enabled: z.boolean(),
    mode: z.string(),
  }),
});

export type SettingsSnapshot = z.infer<typeof settingsSnapshotSchema>;
export type SettingsFieldState = SettingsSnapshot["fields"][number];
export type SettingsChanges = Record<string, SettingValue>;

export const serverIdentitySchema = z.object({
  serverId: z.object({ available: z.boolean(), value: z.string().nullable(), error: z.string().optional() }),
  banner: z.object({ available: z.boolean(), value: z.string().nullable(), error: z.string().optional() }),
});

export const settingsActionResultSchema = z.object({
  id: z.string().optional(),
  state: z.enum(["applied", "accepted", "pending", "failed", "unknown"]),
  message: z.string(),
  changed: z.boolean().optional(),
  revision: z.string().optional(),
});

export type SettingsActionResult = z.infer<typeof settingsActionResultSchema>;

const reservedValue = /^(?:\*{3,}|<redacted>|\[redacted\]|redacted)(?:\s*(?:[;#]|\/\/).*)?$/i;

export function validateSettingValue(field: SettingField, value: SettingValue) {
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`Choose on or off for ${field.label}.`);
    return;
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value > (field.max ?? Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Enter a valid whole number for ${field.label}.`);
    }
    if (value < (field.min ?? 0)) throw new Error(`${field.label} must be at least ${field.min}.`);
    return;
  }
  if (
    typeof value !== "string" ||
    /[\u2028\u2029]/.test(value) ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '"' || character === "\\",
    ) ||
    value.length > (field.max ?? 200)
  ) {
    throw new Error(`Enter a valid value for ${field.label}.`);
  }
  if (field.id === "serverName" && !value.trim()) throw new Error("Enter a server name.");
  if (field.options && !field.options.includes(value))
    throw new Error(`Choose an available ${field.label.toLowerCase()}.`);
  if (field.type === "url" && value) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Enter a valid banner URL.");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Use an HTTP or HTTPS banner URL without credentials.");
    }
  }
  if (reservedValue.test(value)) throw new Error(`That ${field.label.toLowerCase()} is reserved; choose another.`);
}

const statesByTiming: readonly [string, readonly string[]][] = [
  ["Applies now", ["live", "applied"]],
  ["Next match", ["next-match"]],
  ["After restart", ["next-restart"]],
  ["Pending", ["pending"]],
  ["Host override", ["overridden"]],
];

export function timingLabel(state: string) {
  if (state === "live" || state === "applied") return "Now";
  if (state === "next-match") return "Next match";
  if (state === "next-restart") return "Server restart";
  if (state === "pending") return "Pending";
  if (state === "overridden") return "Host override";
  return "Checked on save";
}

export function timingSymbol(state: string) {
  if (state === "live" || state === "applied") return "⚡";
  if (state === "next-match") return "⏭";
  if (state === "next-restart") return "↻";
  return "";
}

export function displaySettingValue(field: SettingField, value: SettingValue | null | undefined) {
  if (field.secret) return "Hidden by server";
  if (value === null || value === undefined || value === "") return "Not set";
  if (typeof value === "boolean") return value ? "On" : "Off";
  return `${value}${field.id === "scorePeriod" ? "s" : ""}`;
}

export function reviewGroups(changes: SettingsChanges, snapshot: SettingsSnapshot) {
  const rows = Object.entries(changes).map(([id, value]) => {
    const field = settingFieldById[id];
    if (!field) throw new Error("An unknown setting changed. Discard the draft and refresh.");
    validateSettingValue(field, value);
    const before = snapshot.fields.find((entry) => entry.id === id);
    if (field.id === "scorePeriod" && snapshot.scoreTick) {
      if (Number(value) < snapshot.scoreTick.min || Number(value) > snapshot.scoreTick.max) {
        throw new Error(
          `Choose a scoring interval from ${snapshot.scoreTick.min} to ${snapshot.scoreTick.max} seconds.`,
        );
      }
    }
    const valueChange = field.secret
      ? value === ""
        ? "Password removed"
        : "Password updated"
      : `${displaySettingValue(field, before?.value)} → ${displaySettingValue(field, value)}`;
    const timing = statesByTiming.find(([, states]) => states.includes(before?.state ?? ""))?.[0] ?? "Checked on save";
    return { title: timing, line: `${field.label}: ${valueChange}` };
  });
  const titles = [...statesByTiming.map(([title]) => title), "Checked on save"];
  return titles
    .map((title) => ({ title, items: rows.filter((row) => row.title === title).map((row) => row.line) }))
    .filter((group) => group.items.length > 0);
}

export const settingsRefreshOptions = {
  refreshInterval: 15_000,
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  keepPreviousData: true,
} as const;
