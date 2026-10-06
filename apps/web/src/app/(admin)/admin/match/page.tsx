import type { Metadata } from "next";

import { readServerSession } from "~/lib/session/server";

import { MatchSurface } from "./_components/match-surface";

export const metadata: Metadata = { title: "Match & Maps · The UNCs" };

export default async function MatchPage() {
  const session = await readServerSession();
  const csrf = session.status === "authenticated" ? session.user.csrf : "";

  return <MatchSurface csrf={csrf} />;
}
