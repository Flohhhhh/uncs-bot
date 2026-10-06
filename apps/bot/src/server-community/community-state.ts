import { mapLabel } from "../common/map-labels";
import type { z } from "zod";
import { communitySnapshot } from "@uncs/contracts";
type CommunitySnapshot = z.infer<typeof communitySnapshot>;
export function plainLabel(value: string, max = 60) {
  return (
    value
      .replace(/[^\p{L}\p{N} ,'-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max) || "Unknown"
  );
}

export function statusCard(snapshot: CommunitySnapshot | null, online: boolean) {
  const lines = ["**The UNCs · Server status**"];
  if (!online) lines.push("Game connection unavailable. Last observed values may be stale.");
  if (snapshot) {
    const status = snapshot.status;
    lines.push(
      `Server: ${plainLabel(status.serverName)}`,
      `Map: ${plainLabel(mapLabel(status.map))}`,
      `Players: ${status.players.current} / ${status.players.max}`,
    );
    for (const faction of status.factionScores.slice(0, 8))
      if (Number.isFinite(faction.score)) lines.push(`${plainLabel(faction.name, 32)}: ${faction.score}`);
    if (Number.isFinite(status.matchSeconds) && status.matchSeconds! >= 0)
      lines.push(`Reported round time: ${Math.floor(status.matchSeconds! / 60)} minutes`);
    const observed = Date.parse(snapshot.observedAt);
    if (Number.isFinite(observed)) lines.push(`Last observed: <t:${Math.floor(observed / 1000)}:R>`);
  } else lines.push("No successful observation this run.");
  return {
    content: lines.join("\n"),
    embeds: [],
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
  };
}
