import { CircleCheckIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import type { Staff } from "~/lib/session/schema";

export function BackendStatus({ user }: { user: Staff }) {
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
