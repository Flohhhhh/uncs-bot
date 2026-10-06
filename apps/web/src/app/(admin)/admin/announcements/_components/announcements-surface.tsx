"use client";

import { useSelectedAdminServer, useAdminGameMode } from "~/components/admin-server-context";

import { AnnouncementComposer } from "./announcement-composer";
import { CommunityMessagesPanel } from "./community-messages-panel";

export function AnnouncementsSurface({ csrf }: { csrf: string }) {
  const server = useSelectedAdminServer();
  const gameMode = useAdminGameMode();
  if (!server) return null;

  return (
    <section className="flex min-h-full flex-col gap-5 p-4 sm:p-6">
      <header className="flex h-10 shrink-0 items-center">
        <h1 className="text-3xl font-semibold tracking-tight">Announcements</h1>
      </header>

      <AnnouncementComposer server={server} csrf={csrf} previewOnly={gameMode === "sample"} />
      <CommunityMessagesPanel serverId={server.id} />
    </section>
  );
}
