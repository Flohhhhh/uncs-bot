"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useSelectedAdminServer } from "~/components/admin-server-context";
import { TabRail } from "~/components/ui/tab-rail";

import { ActionHistory } from "./action-history";
import { GameCommandLog } from "./game-command-log";

type AuditView = "actions" | "commands";

export function AuditLogsSurface() {
  const server = useSelectedAdminServer();
  if (!server) return null;
  return <ServerAuditLogs key={server.id} server={server} />;
}

function ServerAuditLogs({ server }: { server: NonNullable<ReturnType<typeof useSelectedAdminServer>> }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const params = new URLSearchParams(queryString);
  const requestedView = params.get("view");
  const view: AuditView = server.role === "admin" && requestedView === "commands" ? "commands" : "actions";
  const initialQuery = params.get("id") ?? "";
  const tabs = [
    { value: "actions" as const, label: "Action history" },
    ...(server.role === "admin" ? [{ value: "commands" as const, label: "Game command log" }] : []),
  ];

  const changeView = useCallback(
    (nextView: AuditView) => {
      const next = new URLSearchParams(queryString);
      if (nextView === "actions") next.delete("view");
      else next.set("view", nextView);
      next.delete("id");
      const serialized = next.toString();
      router.replace(serialized ? `${pathname}?${serialized}` : pathname, { scroll: false });
    },
    [pathname, queryString, router],
  );

  return (
    <section className="grid h-[calc(100svh-3rem)] min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-5 overflow-hidden p-4 sm:p-6">
      <header className="flex h-10 shrink-0 items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Audit Logs</h1>
      </header>
      <TabRail value={view} onValueChange={changeView} tabs={tabs} ariaLabel="Audit log views" panelClassName="pt-4">
        {view === "commands" ? (
          <GameCommandLog server={server} />
        ) : (
          <ActionHistory key={initialQuery} server={server} initialQuery={initialQuery} />
        )}
      </TabRail>
    </section>
  );
}
