import type { Metadata } from "next";

import { PlayersSurface } from "./_components/players-surface";
import { readServerSession } from "~/lib/session/server";

export const metadata: Metadata = { title: "Players · The UNCs" };

export default async function PlayersPage() {
  const session = await readServerSession();
  const csrf = session.status === "authenticated" ? session.user.csrf : "";

  return <PlayersSurface csrf={csrf} />;
}
