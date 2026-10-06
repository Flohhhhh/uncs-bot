import type { Metadata } from "next";

import { readServerSession } from "~/lib/session/server";

import { AnnouncementsSurface } from "./_components/announcements-surface";

export const metadata: Metadata = { title: "Announcements · The UNCs" };

export default async function AnnouncementsPage() {
  const session = await readServerSession();
  const csrf = session.status === "authenticated" ? session.user.csrf : "";

  return <AnnouncementsSurface csrf={csrf} />;
}
