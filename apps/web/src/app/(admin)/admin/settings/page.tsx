import type { Metadata } from "next";

import { AdminComingSoon } from "~/components/admin-coming-soon";

export const metadata: Metadata = { title: "Settings · The UNCs" };

export default function SettingsPage() {
  return <AdminComingSoon group="Server" title="Settings" />;
}
