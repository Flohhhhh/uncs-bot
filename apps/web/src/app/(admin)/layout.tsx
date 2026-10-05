import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { SessionUnavailable } from "~/components/session-feedback";
import { StaffAccount } from "~/components/staff-account";
import { ThemeSelector } from "~/components/theme-selector";
import { Separator } from "~/components/ui/separator";
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
    <div className="flex min-h-svh flex-col">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:p-4">
        Skip to content
      </a>
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-5 sm:px-10">
        <Link href="/admin" aria-label="The UNCs dashboard" className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-9 items-center justify-center rounded-lg bg-primary font-mono text-lg font-bold text-primary-foreground"
          >
            U
          </span>
          <span className="text-base font-semibold tracking-tight">
            The UNCs<span className="ml-3 font-mono text-xs font-normal text-muted-foreground">/ DASHBOARD</span>
          </span>
        </Link>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <StaffAccount user={session.user} />
          <ThemeSelector />
        </div>
      </header>
      <Separator />
      <main id="main-content" className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10 sm:px-10">
        {children}
      </main>
    </div>
  );
}
