"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { SessionLoading, SessionUnavailable } from "~/components/session-feedback";
import { useSession } from "~/components/session-provider";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";

export function AuthPanel({ denied = false, reason }: { denied?: boolean; reason?: string }) {
  const session = useSession();
  const router = useRouter();
  const accessDenied = denied || session.status === "denied";
  useEffect(() => {
    if (session.status === "authenticated") router.replace("/admin");
  }, [session.status, router]);
  if (session.status === "checking" || session.status === "authenticated") return <SessionLoading />;
  if (session.failure === "logout") return <SessionUnavailable />;
  const reasonMessage =
    reason === "expired"
      ? "Sign-in expired. Start again with Discord."
      : reason === "unavailable"
        ? "Discord sign-in could not be reached. Try again shortly."
        : undefined;
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">The UNCs / Staff access</p>
        <CardTitle>{accessDenied ? "Access denied" : "Sign in with Discord"}</CardTitle>
        <CardDescription>
          {accessDenied
            ? "Your Discord account could not be approved for staff access."
            : "Use your community Discord account to open the staff dashboard."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {accessDenied
            ? "Staff access requires an assigned Discord role, completed server membership screening and two-factor authentication. Contact a community administrator if you need access."
            : "Staff access requires an assigned Discord role and two-factor authentication."}
        </p>
        {reasonMessage || session.message ? (
          <p role="status" className="text-sm text-muted-foreground">
            {reasonMessage ?? session.message}
          </p>
        ) : null}
        {session.status === "unavailable" ? (
          <Button variant="outline" onClick={() => void session.refresh()}>
            Retry connection
          </Button>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-col items-stretch gap-4">
        <Button asChild>
          <a href="/admin/auth/login">{accessDenied ? "Try signing in again" : "Continue with Discord"}</a>
        </Button>
        <Link
          href="https://theuncsgaming.com/"
          className="text-center text-sm text-muted-foreground underline underline-offset-4"
        >
          Back to the community
        </Link>
      </CardFooter>
    </Card>
  );
}
