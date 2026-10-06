import type { Metadata } from "next";

import { AdminComingSoon } from "~/components/admin-coming-soon";

export const metadata: Metadata = { title: "Bans · The UNCs" };

export default function BansPage() {
  return <AdminComingSoon group="Moderation" title="Bans" />;
}
