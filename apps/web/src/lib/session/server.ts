import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

import { getBackendUrl } from "~/lib/backend-url";

import { staffSchema, type Staff } from "./schema";

export type ServerSessionResult =
  | { status: "authenticated"; user: Staff }
  | { status: "signed-out" }
  | { status: "denied" }
  | { status: "unavailable"; message?: string };

async function readServerSessionUncached(): Promise<ServerSessionResult> {
  const backendUrl = getBackendUrl();
  if (!backendUrl) {
    return {
      status: "unavailable",
      message: "The backend URL is not configured. Check the web app environment and try again.",
    };
  }

  try {
    const cookieHeader = (await cookies()).toString();
    const response = await fetch(`${backendUrl.replace(/\/$/, "")}/admin/api/me`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 401) {
      void response.body?.cancel().catch(() => {});
      return { status: "signed-out" };
    }
    if (response.status === 403) {
      void response.body?.cancel().catch(() => {});
      return { status: "denied" };
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return {
        status: "unavailable",
        message: "Staff access is temporarily unavailable. Check the backend connection and try again.",
      };
    }

    const parsed = staffSchema.safeParse(await response.json());
    if (!parsed.success) {
      return {
        status: "unavailable",
        message: "The backend returned an invalid staff session. Try again shortly.",
      };
    }
    return { status: "authenticated", user: parsed.data };
  } catch {
    return {
      status: "unavailable",
      message: "Staff access could not be verified. Check the backend connection and try again.",
    };
  }
}

export const readServerSession = cache(readServerSessionUncached);
