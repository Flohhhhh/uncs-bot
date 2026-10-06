import type { Metadata } from "next";

import { readServerSession } from "~/lib/session/server";

import { DiscordRolesSurface } from "./_components/discord-roles-surface";

export const metadata: Metadata = { title: "Discord roles · The UNCs" };

export default async function DiscordRolesPage() {
  const session = await readServerSession();
  if (session.status !== "authenticated") return null;

  return <DiscordRolesSurface csrf={session.user.csrf} canRead={session.user.role === "admin"} />;
}
