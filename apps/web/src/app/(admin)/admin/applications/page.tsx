import type { Metadata } from "next";

import { AdminComingSoon } from "~/components/admin-coming-soon";

export const metadata: Metadata = { title: "Applications · The UNCs" };

export default function ApplicationsPage() {
  return <AdminComingSoon group="Community" title="Applications" />;
}
