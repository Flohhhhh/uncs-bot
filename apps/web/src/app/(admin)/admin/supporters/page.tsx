import type { Metadata } from "next";

import { AdminComingSoon } from "~/components/admin-coming-soon";

export const metadata: Metadata = { title: "Supporters · The UNCs" };

export default function SupportersPage() {
  return <AdminComingSoon group="Community" title="Supporters" />;
}
