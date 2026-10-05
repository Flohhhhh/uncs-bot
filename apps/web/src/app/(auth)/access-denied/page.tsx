import type { Metadata } from "next";

import { AuthPanel } from "~/components/auth-panel";

export const metadata: Metadata = { title: "Access denied · The UNCs" };

export default function AccessDeniedPage() {
  return <AuthPanel denied />;
}
