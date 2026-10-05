import type { Metadata } from "next";

import { BackendStatus } from "~/components/backend-status";

import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";

export const metadata: Metadata = { title: "Admin · The UNCs" };

export default function AdminPage() {
  return (
    <>
      <div className="flex max-w-3xl flex-col gap-5">
        <p className="font-mono text-xs font-medium tracking-widest text-muted-foreground uppercase">
          The UNCs / Community headquarters
        </p>
        <h1 className="text-5xl font-semibold tracking-tight sm:text-7xl">
          Good games.
          <br />
          Older knees.
        </h1>
        <p className="max-w-lg text-lg leading-relaxed text-muted-foreground">
          A new home for the people who keep the community running.
        </p>
      </div>
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Community admin</CardTitle>
          <CardDescription>The new dashboard is taking shape.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Your community tools will live here. For now, keep using the existing staff dashboard.
          </p>
        </CardContent>
        <CardFooter className="flex-wrap gap-3">
          <Badge variant="secondary">Coming soon</Badge>
          <BackendStatus />
        </CardFooter>
      </Card>
    </>
  );
}
