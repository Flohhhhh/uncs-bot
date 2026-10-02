// Verified against the official WARDOGS console and standalone template on 2026-10-01.
// Only documented keys belong here. Host-only controls are listed separately in the UI.
export const SESSION = "/Script/WDGame.WDGameSession";
export const ROTATION = "/Script/WDGame.WDServerMapRotationSettings";
export type SettingValue = string | number | boolean;
export type SettingField = {
  id: string;
  section: string;
  key: string;
  label: string;
  group: string;
  type: "text" | "number" | "boolean" | "select" | "url" | "password";
  help: string;
  min?: number;
  max?: number;
  options?: string[];
  secret?: boolean;
};
export const settingFields: SettingField[] = [
  {
    id: "serverName",
    section: SESSION,
    key: "ServerName",
    label: "Server name",
    group: "Identity",
    type: "text",
    max: 64,
    help: "Name shown in the game’s server browser.",
  },
  {
    id: "imageUrl",
    section: SESSION,
    key: "ServerImageURL",
    label: "Server banner URL",
    group: "Identity",
    type: "url",
    max: 2048,
    help: "1024 × 256 PNG or JPEG on a host allowed by the game. The game validates the image.",
  },
  {
    id: "serverPassword",
    section: SESSION,
    key: "ServerPassword",
    label: "Join password",
    group: "Joining",
    type: "password",
    secret: true,
    max: 128,
    help: "Enter a replacement, or clear it to open the server. The existing password is never displayed.",
  },
  {
    id: "maxPlayers",
    section: "/Script/Engine.GameSession",
    key: "MaxPlayers",
    label: "Player capacity",
    group: "Joining",
    type: "number",
    min: 1,
    help: "Includes reserved slots; the game enforces the host’s capacity limits.",
  },
  {
    id: "maxReservedSlots",
    section: SESSION,
    key: "MaxReservedSlots",
    label: "Reserved-slot capacity",
    group: "Joining",
    type: "number",
    min: 0,
    help: "Changes capacity only. Manage individual players under Whitelist.",
  },
  {
    id: "minPlayerCash",
    section: SESSION,
    key: "ServerMinPlayerCash",
    label: "Minimum player cash",
    group: "Joining",
    type: "number",
    min: 0,
    help: "0 removes this joining restriction.",
  },
  {
    id: "maxPlayerCash",
    section: SESSION,
    key: "ServerMaxPlayerCash",
    label: "Maximum player cash",
    group: "Joining",
    type: "number",
    min: 0,
    help: "0 removes this joining restriction.",
  },
  {
    id: "minPlayerLevel",
    section: SESSION,
    key: "ServerMinPlayerLevel",
    label: "Minimum player level",
    group: "Joining",
    type: "number",
    min: 0,
    help: "0 removes this joining restriction.",
  },
  {
    id: "maxPlayerLevel",
    section: SESSION,
    key: "ServerMaxPlayerLevel",
    label: "Maximum player level",
    group: "Joining",
    type: "number",
    min: 0,
    help: "0 removes this joining restriction.",
  },
  {
    id: "minRequiredPlayers",
    section: "MatchState.PreMatch.WaitingForPlayers.PlayerCount",
    key: "MinimumRequiredPlayers",
    label: "Players to start a match",
    group: "Gameplay",
    type: "number",
    min: 20,
    help: "The game will not start a match with fewer than 20 players.",
  },
  {
    id: "scorePeriod",
    section: "MatchState.Playing.KOTH",
    key: "ScorePeriod",
    label: "Scoring interval (seconds)",
    group: "Gameplay",
    type: "number",
    min: 1,
    help: "Seconds between scoring ticks. Faster ticks pay less per tick; the server supplies the allowed range.",
  },
  {
    id: "lockOverpopulated",
    section: "/Script/WDGame.WDGameStateSession",
    key: "bLockOverpopulatedTeamsConfig",
    label: "Lock overpopulated teams",
    group: "Gameplay",
    type: "boolean",
    help: "Prevent joining a team that exceeds the population threshold.",
  },
  {
    id: "overpopThreshold",
    section: "/Script/WDGame.WDGameStateSession",
    key: "OverpopulatedTeamThresholdConfig",
    label: "Team population threshold",
    group: "Gameplay",
    type: "number",
    min: 0,
    help: "How many players ahead a team can be before it locks.",
  },
  {
    id: "rotationEnabled",
    section: ROTATION,
    key: "bEnabled",
    label: "Enable map rotation",
    group: "Rotation",
    type: "boolean",
    help: "Advance through the rotation after each match.",
  },
  {
    id: "rotationMode",
    section: ROTATION,
    key: "RotationMode",
    label: "Rotation order",
    group: "Rotation",
    type: "select",
    options: ["Ordered", "Random"],
    help: "A queued next map requires an enabled, ordered rotation.",
  },
];
export type MapSelection = { map: string; experiences: string[]; lighting?: string; zoneAlternator?: string };
export type RotationCheck = {
  revision: string;
  total: number;
  issues: { index: number; message: string; unavailable: boolean }[];
};
export type SettingsSnapshot = {
  revision: string;
  writable: boolean;
  notice: string;
  fields: { id: string; value: SettingValue | null; editable: boolean; note: string; state: string }[];
  scoreTick: { current: number; min: number; max: number } | null;
  rotation: {
    entries: MapSelection[];
    editable: boolean;
    note: string;
    currentIndex: number | null;
    /** The entry played after this match; set without `currentIndex` when the game names only its next entry. */
    nextIndex: number | null;
    positionNote?: string;
    currentMap: string;
    enabled: boolean;
    mode: string;
  };
};
export function settingValue(field: SettingField, value: unknown): SettingValue {
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`Choose on or off for ${field.label}.`);
    return value;
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value > (field.max ?? Number.MAX_SAFE_INTEGER))
      throw new Error(`Enter a valid whole number for ${field.label}.`);
    if (value < (field.min ?? 0)) throw new Error(`${field.label} must be at least ${field.min}.`);
    return value;
  }
  if (
    typeof value !== "string" ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '"' || character === "\\",
    ) ||
    value.length > (field.max ?? 200)
  )
    throw new Error(`Enter a valid value for ${field.label}.`);
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
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("Use an HTTP or HTTPS banner URL without credentials.");
  }
  return value;
}
