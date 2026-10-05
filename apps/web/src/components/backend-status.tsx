"use client";

import { CircleCheckIcon } from "lucide-react";

import { useSession } from "~/components/session-provider";
import { Badge } from "~/components/ui/badge";

export function BackendStatus() {
  const { user } = useSession();
  if (!user) return null;
  return (
    <span role="status" className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary">
        <CircleCheckIcon aria-hidden="true" />
        {user.demo ? "Local preview connected" : "Backend connected"}
      </Badge>
      {user.gameMode === "sample" ? <Badge variant="outline">Sample game data</Badge> : null}
    </span>
  );
}
