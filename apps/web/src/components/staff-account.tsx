"use client";

import { ChevronsUpDownIcon, LogOutIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { SidebarMenuButton } from "~/components/ui/sidebar";
import { endSession, SessionError } from "~/lib/session/client";
import type { Staff } from "~/lib/session/schema";

export function StaffAccount({ user }: { user: Staff }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "signing-out" | "failed">("idle");

  async function signOut() {
    if (status === "signing-out") return;
    setStatus("signing-out");
    try {
      await endSession(user.csrf, new AbortController().signal);
      router.replace("/sign-in");
    } catch (error) {
      if (error instanceof SessionError && error.status === 401) {
        router.replace("/sign-in");
        return;
      }
      setStatus("failed");
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="lg"
            title={`Account menu for ${user.name}`}
            aria-label={`Account menu for ${user.name}`}
          >
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary font-semibold text-sidebar-primary-foreground"
            >
              {user.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
              <span className="truncate text-sm font-medium">{user.name}</span>
              <span className="truncate text-xs text-sidebar-foreground/70">{user.role}</span>
            </span>
            <ChevronsUpDownIcon className="ml-auto" aria-hidden="true" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="min-w-56">
          <DropdownMenuLabel className="flex flex-col gap-2">
            <span className="truncate">{user.name}</span>
            <span className="flex flex-wrap gap-2">
              <Badge variant="outline">{user.role}</Badge>
              {user.demo ? <Badge variant="secondary">Local preview</Badge> : null}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {status === "failed" ? (
            <DropdownMenuLabel className="text-xs font-normal whitespace-normal text-destructive">
              Sign-out could not be confirmed. Retry to end the browser session.
            </DropdownMenuLabel>
          ) : null}
          <DropdownMenuItem variant="destructive" onSelect={() => void signOut()} disabled={status === "signing-out"}>
            <LogOutIcon aria-hidden="true" />
            {status === "signing-out" ? "Signing out…" : status === "failed" ? "Retry sign out" : "Sign out"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {status === "failed" ? (
        <span role="alert" className="px-2 text-xs text-muted-foreground">
          Sign-out failed. Open the account menu to retry.
        </span>
      ) : null}
    </div>
  );
}
