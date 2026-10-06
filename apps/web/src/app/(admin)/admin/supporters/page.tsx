import type { Metadata } from "next";

import { readServerSession } from "~/lib/session/server";

import { SupportersSurface } from "./_components/supporters-surface";

export const metadata: Metadata = { title: "Supporters · The UNCs" };

export default async function SupportersPage() {
  const session = await readServerSession();
  if (session.status !== "authenticated") return null;

  return <SupportersSurface csrf={session.user.csrf} canRead={session.user.role === "admin"} />;
}
