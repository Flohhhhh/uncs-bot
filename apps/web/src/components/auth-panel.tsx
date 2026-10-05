import Link from "next/link";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";

export function AuthPanel({
  denied = false,
  reason,
  unavailableMessage,
}: {
  denied?: boolean;
  reason?: string;
  unavailableMessage?: string;
}) {
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
        <CardTitle>
          {denied ? "Access denied" : unavailableMessage ? "Sign-in unavailable" : "Sign in with Discord"}
        </CardTitle>
        <CardDescription>
          {denied
            ? "Your Discord account could not be approved for staff access."
            : "Use your community Discord account to open the staff dashboard."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {denied
            ? "Staff access requires an assigned Discord role, completed server membership screening and two-factor authentication. Contact a community administrator if you need access."
            : "Staff access requires an assigned Discord role and two-factor authentication."}
        </p>
        {unavailableMessage || reasonMessage ? (
          <p role="status" className="text-sm text-muted-foreground">
            {unavailableMessage ?? reasonMessage}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-col items-stretch gap-4">
        {unavailableMessage ? (
          <Button asChild variant="outline">
            <a href="/sign-in">Try again</a>
          </Button>
        ) : (
          <Button asChild>
            <a href="/admin/auth/login">{denied ? "Try signing in again" : "Continue with Discord"}</a>
          </Button>
        )}
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
