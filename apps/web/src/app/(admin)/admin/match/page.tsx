import type { Metadata } from "next";

import { AdminComingSoon } from "~/components/admin-coming-soon";

export const metadata: Metadata = { title: "Match & maps · The UNCs" };

export default function MatchPage() {
  return <AdminComingSoon group="Live" title="Match & maps" />;
}
