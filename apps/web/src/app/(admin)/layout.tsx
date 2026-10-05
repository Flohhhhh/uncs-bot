import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Suspense } from "react";

import { AdminShell } from "~/components/admin-shell";
import { SessionUnavailable } from "~/components/session-feedback";
import { readServerSession } from "~/lib/session/server";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await readServerSession();
  if (session.status === "signed-out") redirect("/sign-in");
  if (session.status === "denied") redirect("/access-denied");
  if (session.status === "unavailable") {
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <SessionUnavailable message={session.message} />
      </main>
    );
  }

  return (
    <Suspense fallback={<AdminShellFallback />}>
      <AdminShell user={session.user}>{children}</AdminShell>
    </Suspense>
  );
}

function AdminShellFallback() {
  return (
    <div className="flex min-h-svh w-full" role="status">
      <aside className="hidden w-64 shrink-0 border-r bg-sidebar md:block" />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="h-12 shrink-0 border-b bg-background" />
        <p className="sr-only">Loading admin dashboard…</p>
      </main>
    </div>
  );
}
