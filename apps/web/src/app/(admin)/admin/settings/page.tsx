import type { Metadata } from "next";

import { readServerSession } from "~/lib/session/server";

import { SettingsSurface } from "./_components/settings-surface";

export const metadata: Metadata = { title: "Settings · The UNCs" };

export default async function SettingsPage() {
  const session = await readServerSession();
  const csrf = session.status === "authenticated" ? session.user.csrf : "";

  return <SettingsSurface csrf={csrf} />;
}
