"use client";

import { useSession } from "~/components/session-provider";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";

export function SessionLoading() {
  return (
    <div role="status" className="mx-auto flex w-full max-w-sm flex-col gap-4 p-6">
      <span className="text-sm text-muted-foreground">Checking staff access…</span>
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

export function SessionUnavailable() {
  const session = useSession();
  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>Connection needs attention</CardTitle>
        <CardDescription>Staff access is temporarily unavailable.</CardDescription>
      </CardHeader>
      <CardContent>
        <p role="alert" className="text-sm text-muted-foreground">
          {session.message}
        </p>
      </CardContent>
      <CardFooter>
        <Button onClick={() => void (session.failure === "logout" ? session.signOut() : session.refresh())}>
          {session.failure === "logout" ? "Retry sign-out" : "Try again"}
        </Button>
      </CardFooter>
    </Card>
  );
}
