import { useState } from "react";
import { useResource } from "../../api/use-resource";
import type { RepeatOffenderList } from "../../api/types";
import { Card } from "../../components/ui";
import { lastText } from "../players/moderation-history";
import { PlayerButton, PlayerSheet, type SheetPlayer } from "../players/player-actions";

/** Players kicked often lately on the selected server, most kicks first. Shows nothing until one qualifies. */
export function RepeatOffenders() {
  const { data } = useResource<RepeatOffenderList>("moderation/repeat-offenders");
  const [sheet, setSheet] = useState<SheetPlayer | null>(null);
  if (!data?.players?.length) return null;
  return (
    <>
      <Card
        className="repeat-offenders"
        title="Repeat offenders"
        subtitle={`${data.minimum}+ kicks in the last ${data.days} days`}
      >
        <ul>
          {data.players.map((player) => (
            <li key={player.steamId}>
              <PlayerButton player={{ steamId: player.steamId, name: player.name ?? undefined }} onOpen={setSheet} />
              <span>
                {player.kicks.recent} kicks · {lastText(player.kicks)}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      {sheet && <PlayerSheet player={sheet} onClose={() => setSheet(null)} />}
    </>
  );
}
