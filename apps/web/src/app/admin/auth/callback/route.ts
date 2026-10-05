import { forwardAuth } from "~/lib/auth-forwarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET(request: Request) {
  return forwardAuth(request, "callback");
}
