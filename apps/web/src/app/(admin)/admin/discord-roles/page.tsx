import type { Metadata } from "next";

import { AdminComingSoon } from "~/components/admin-coming-soon";

export const metadata: Metadata = { title: "Discord roles · The UNCs" };

export default function DiscordRolesPage() {
  return <AdminComingSoon group="Community" title="Discord roles" />;
}
