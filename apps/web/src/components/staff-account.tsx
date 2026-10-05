"use client";

import { LogOutIcon } from "lucide-react";

import { useSession } from "~/components/session-provider";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

export function StaffAccount() {
  const { user, signOut } = useSession();
  if (!user) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm font-medium">{user.name}</span>
      <Badge variant="outline">{user.role}</Badge>
      {user.demo ? <Badge variant="secondary">Local preview</Badge> : null}
      <Button size="sm" variant="outline" onClick={() => void signOut()}>
        <LogOutIcon data-icon="inline-start" />
        Sign out
      </Button>
    </div>
  );
}
