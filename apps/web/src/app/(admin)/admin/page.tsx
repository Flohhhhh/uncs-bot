import type { Metadata } from "next";
import Link from "next/link";

import { CombinedActivityCard } from "~/components/overview/combined-activity-card";
import { CurrentMatchCard } from "~/components/overview/current-match-card";
import { MatchMapRail } from "~/components/overview/match-map-rail";
import { PlayerListSummaryCard } from "~/components/overview/player-list-summary-card";
import { Button } from "~/components/ui/button";

export const metadata: Metadata = { title: "Dashboard · The UNCs" };

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ server?: string | string[] }> }) {
  const params = await searchParams;
  const requestedServer = params.server;
  const serverId = (Array.isArray(requestedServer) ? requestedServer[0] : requestedServer) ?? "primary";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 p-4 sm:p-6">
      {/* quick actions rail */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link href={`/admin/announcements?server=${encodeURIComponent(serverId)}`}>Send announcement</Link>
          </Button>
          <Button asChild size="sm" variant="secondary">
            <Link href={`/admin/whitelist?server=${encodeURIComponent(serverId)}`}>Add player to whitelist</Link>
          </Button>
        </div>
      </div>
      {/* Card grid */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)]">
        <CurrentMatchCard serverId={serverId} />
        <MatchMapRail serverId={serverId} />
        <CombinedActivityCard serverId={serverId} />
        <PlayerListSummaryCard serverId={serverId} />
      </div>
    </div>
  );
}
