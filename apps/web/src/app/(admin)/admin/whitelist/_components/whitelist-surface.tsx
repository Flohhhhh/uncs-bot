"use client";

import { useCallback } from "react";
import { useSWRConfig } from "swr";

import { useSelectedAdminServer } from "~/components/admin-server-context";
import { Button } from "~/components/ui/button";
import { apiResponseCacheKey, serverApiPath } from "~/components/overview/overview-data";

import { ApplicationsSection } from "./applications-section";
import { WhitelistSection } from "./whitelist-section";

export function WhitelistSurface({ csrf }: { csrf: string }) {
  const server = useSelectedAdminServer();
  return server ? <ServerWhitelist key={server.id} server={server} csrf={csrf} /> : null;
}

function ServerWhitelist({
  server,
  csrf,
}: {
  server: NonNullable<ReturnType<typeof useSelectedAdminServer>>;
  csrf: string;
}) {
  const { mutate } = useSWRConfig();
  const applicationPath = serverApiPath(server.id, "applications");
  const whitelistPath = serverApiPath(server.id, "whitelist");
  const overviewPath = serverApiPath(server.id, "overview");

  const refreshData = useCallback(async () => {
    const paths = [applicationPath, whitelistPath].filter((path): path is string => path !== null);
    await Promise.all([
      ...paths.map((path) => mutate(path)),
      overviewPath ? mutate(apiResponseCacheKey(overviewPath, "whitelist-overview")) : Promise.resolve(),
    ]);
  }, [applicationPath, mutate, overviewPath, whitelistPath]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-6">
        <header className="flex min-h-10 items-center justify-between gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">Whitelist</h1>
          <Button variant="secondary" size="sm" onClick={() => void refreshData()}>
            Refresh
          </Button>
        </header>

        <ApplicationsSection server={server} csrf={csrf} onDataChanged={refreshData} />
        <WhitelistSection server={server} csrf={csrf} onDataChanged={refreshData} />
      </div>
    </div>
  );
}
