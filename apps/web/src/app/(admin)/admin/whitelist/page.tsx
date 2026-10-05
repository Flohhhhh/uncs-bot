import type { Metadata } from "next";

import { AdminComingSoon } from "~/components/admin-coming-soon";

export const metadata: Metadata = { title: "Whitelist · The UNCs" };

export default function WhitelistPage() {
  return <AdminComingSoon group="Community" title="Whitelist" />;
}
