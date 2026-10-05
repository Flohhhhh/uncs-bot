"use client";

import { ThemeProvider } from "next-themes";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import type { ReactNode } from "react";

import { SessionProvider } from "~/components/session-provider";
import { Toaster } from "~/components/ui/sonner";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <NuqsAdapter>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <SessionProvider>{children}</SessionProvider>
        <Toaster />
      </ThemeProvider>
    </NuqsAdapter>
  );
}
