import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthPanel } from "~/components/auth-panel";
import { readServerSession } from "~/lib/session/server";

export const metadata: Metadata = { title: "Staff sign-in · The UNCs" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ reason?: string | string[] }> }) {
  const { reason } = await searchParams;
  const session = await readServerSession();
  if (session.status === "authenticated") redirect("/admin");
  if (session.status === "denied") return <AuthPanel denied />;

  return (
    <AuthPanel
      reason={typeof reason === "string" ? reason : undefined}
      unavailableMessage={session.status === "unavailable" ? session.message : undefined}
    />
  );
}
