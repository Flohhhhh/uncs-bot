import type { Metadata } from "next";

import { ActivitySurface } from "./_components/activity-surface";

export const metadata: Metadata = { title: "Server activity · The UNCs" };

export default function ActivityPage() {
  return <ActivitySurface />;
}
