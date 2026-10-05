"use client";

import { CircleCheckIcon } from "lucide-react";

import { useSession } from "~/components/session-provider";
import { Badge } from "~/components/ui/badge";

export function BackendStatus() {
  const { user } = useSession();
  if (!user) return null;
  return (
    <span role="status">
      <Badge variant="secondary">
        <CircleCheckIcon aria-hidden="true" />
        {user.demo ? "Local preview connected" : "Backend connected"}
      </Badge>
    </span>
  );
}
