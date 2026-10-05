import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthPanel } from "~/components/auth-panel";
import { readServerSession } from "~/lib/session/server";

export const metadata: Metadata = { title: "Access denied · The UNCs" };

export default async function AccessDeniedPage() {
  const session = await readServerSession();
  if (session.status === "authenticated") redirect("/admin");

  return <AuthPanel denied />;
}
