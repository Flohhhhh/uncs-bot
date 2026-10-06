import { getBackendUrl } from "~/lib/backend-url";
export const dynamic = "force-dynamic";
export async function GET() {
  const backend = getBackendUrl();
  if (!backend) return Response.json({ status: "unavailable" }, { status: 503 });
  try {
    const response = await fetch(new URL("/health/ready", backend), {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    await response.body?.cancel();
    return Response.json({ status: response.ok ? "ready" : "unavailable" }, { status: response.ok ? 200 : 503 });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
