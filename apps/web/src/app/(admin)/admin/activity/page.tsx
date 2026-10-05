import type { Metadata } from "next";

import { AdminComingSoon } from "~/components/admin-coming-soon";

export const metadata: Metadata = { title: "Server activity · The UNCs" };

export default function ActivityPage() {
  return <AdminComingSoon group="Live" title="Server activity" />;
}
