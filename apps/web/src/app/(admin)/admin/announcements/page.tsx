import type { Metadata } from "next";

import { AdminComingSoon } from "~/components/admin-coming-soon";

export const metadata: Metadata = { title: "Announcements · The UNCs" };

export default function AnnouncementsPage() {
  return <AdminComingSoon group="Community" title="Announcements" />;
}
