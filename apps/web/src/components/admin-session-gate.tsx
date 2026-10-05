"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { SessionLoading, SessionUnavailable } from "~/components/session-feedback";
import { useSession } from "~/components/session-provider";

export function AdminSessionGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const router = useRouter();
  useEffect(() => {
    if (session.status === "signed-out") router.replace("/sign-in");
    if (session.status === "denied") router.replace("/access-denied");
  }, [session.status, router]);
  if (session.status === "unavailable")
    return (
      <div className="flex min-h-svh items-center p-6">
        <SessionUnavailable />
      </div>
    );
  if (session.status !== "authenticated") return <SessionLoading />;
  return children;
}
