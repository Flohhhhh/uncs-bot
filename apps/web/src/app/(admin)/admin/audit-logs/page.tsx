import type { Metadata } from "next";

import { AuditLogsSurface } from "./_components/audit-logs-surface";

export const metadata: Metadata = { title: "Audit Logs · The UNCs" };

export default function AuditLogsPage() {
  return <AuditLogsSurface />;
}
