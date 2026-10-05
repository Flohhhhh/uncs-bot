import type { Metadata } from "next";

import { AuthPanel } from "~/components/auth-panel";

export const metadata: Metadata = { title: "Staff sign-in · The UNCs" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ reason?: string | string[] }> }) {
  const { reason } = await searchParams;
  return <AuthPanel reason={typeof reason === "string" ? reason : undefined} />;
}
