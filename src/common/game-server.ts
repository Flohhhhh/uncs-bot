import { z } from "zod";

export const LEGACY_SERVER_ID = "primary";
export const gameServerId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Use a stable lowercase server ID.");
export type GameServerSummary = { id: string; name: string };
export type RconConnection = { rconUrl: string; password: string };
export interface RconConnectionSource {
  rcon(): RconConnection;
}

export function validRconUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      !/\s/.test(value) &&
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export const gameServerConnections = z
  .array(
    z
      .object({
        id: gameServerId,
        name: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .refine(
            (value) =>
              [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
            "Use a single-line server name.",
          ),
        rconUrl: z
          .string()
          .max(2048)
          .refine(validRconUrl, "Use an HTTP(S) endpoint without embedded credentials, query or fragment."),
        password: z
          .string()
          .min(1)
          .max(512)
          .refine(
            (value) =>
              value.trim().length > 0 &&
              [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
            "Use a non-empty, single-line RCON password.",
          ),
      })
      .strict(),
  )
  .min(1)
  .max(20)
  .superRefine((servers, context) => {
    const ids = new Set<string>(),
      endpoints = new Set<string>();
    servers.forEach((server, index) => {
      if (ids.has(server.id))
        context.addIssue({ code: "custom", path: [index, "id"], message: "Server IDs must be unique." });
      ids.add(server.id);
      if (!validRconUrl(server.rconUrl)) return;
      const endpoint = new URL(server.rconUrl).href.replace(/\/+$/, "");
      if (endpoints.has(endpoint))
        context.addIssue({
          code: "custom",
          path: [index, "rconUrl"],
          message: "Each server needs its own connection endpoint.",
        });
      endpoints.add(endpoint);
    });
  });

export type GameServerConnection = z.infer<typeof gameServerConnections>[number];
