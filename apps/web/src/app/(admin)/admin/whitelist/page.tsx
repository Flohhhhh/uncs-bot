import type { Metadata } from "next";

import { readServerSession } from "~/lib/session/server";

import { WhitelistSurface } from "./_components/whitelist-surface";

export const metadata: Metadata = { title: "Whitelist · The UNCs" };

export default async function WhitelistPage() {
  const session = await readServerSession();
  const csrf = session.status === "authenticated" ? session.user.csrf : "";

  return <WhitelistSurface csrf={csrf} />;
}
