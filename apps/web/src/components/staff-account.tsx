"use client";

import { LogOutIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
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
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm font-medium">{user.name}</span>
      <Badge variant="outline">{user.role}</Badge>
      {user.demo ? <Badge variant="secondary">Local preview</Badge> : null}
      <Button size="sm" variant="outline" onClick={() => void signOut()} disabled={status === "signing-out"}>
        <LogOutIcon data-icon="inline-start" />
        {status === "signing-out" ? "Signing out…" : status === "failed" ? "Retry sign out" : "Sign out"}
      </Button>
      {status === "failed" ? (
        <span role="alert" className="w-full text-right text-xs text-muted-foreground">
          Sign-out could not be confirmed. Retry to end the browser session.
        </span>
      ) : null}
    </div>
  );
}
