import Link from "next/link";
import type { ReactNode } from "react";

import { AdminSessionGate } from "~/components/admin-session-gate";
import { StaffAccount } from "~/components/staff-account";
import { ThemeSelector } from "~/components/theme-selector";
import { Separator } from "~/components/ui/separator";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AdminSessionGate>
      <div className="flex min-h-svh flex-col">
        <a href="#main-content" className="sr-only focus:not-sr-only focus:p-4">
          Skip to content
        </a>
        <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-6 sm:px-10">
          <Link href="/admin" aria-label="The UNCs admin" className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex size-10 items-center justify-center rounded-lg bg-primary font-mono text-lg font-bold text-primary-foreground"
            >
              U
            </span>
            <span className="text-lg font-semibold tracking-tight">
              The UNCs<span className="ml-3 font-mono text-xs font-normal text-muted-foreground">/ ADMIN</span>
            </span>
          </Link>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <StaffAccount />
            <ThemeSelector />
          </div>
        </header>
        <Separator />
        <main
          id="main-content"
          className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center gap-8 px-6 py-16 sm:px-10"
        >
          {children}
        </main>
        <Separator />
        <footer className="mx-auto flex w-full max-w-6xl flex-wrap justify-between gap-3 px-6 py-6 text-sm text-muted-foreground sm:px-10">
          <span>The UNCs gaming community</span>
          <span>Good games. Older knees.</span>
        </footer>
      </div>
    </AdminSessionGate>
  );
}
