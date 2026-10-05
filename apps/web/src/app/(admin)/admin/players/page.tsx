import type { Metadata } from "next";

import { AdminComingSoon } from "~/components/admin-coming-soon";

export const metadata: Metadata = { title: "Players · The UNCs" };

export default function PlayersPage() {
  return <AdminComingSoon group="Live" title="Players" />;
}
