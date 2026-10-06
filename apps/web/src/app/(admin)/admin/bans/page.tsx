import type { Metadata } from "next";

import { readServerSession } from "~/lib/session/server";

import { BansSurface } from "./_components/bans-surface";

export const metadata: Metadata = { title: "Bans · The UNCs" };

export default async function BansPage() {
  const session = await readServerSession();
  const csrf = session.status === "authenticated" ? session.user.csrf : "";

  return <BansSurface csrf={csrf} />;
}
