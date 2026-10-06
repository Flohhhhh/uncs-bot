"use client";

import { useState, type FormEvent } from "react";
import useSWR from "swr";
import { SendIcon } from "lucide-react";

import { readAdminApi, serverApiPath } from "~/components/overview/overview-data";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Textarea } from "~/components/ui/textarea";
import type { AdminServer } from "~/lib/admin-servers";

import { AnnouncementReviewDialog } from "./announcement-review-dialog";
import {
  announcementOverviewSchema,
  hasBroadcastRoute,
  isOverviewFresh,
  liveRefreshOptions,
} from "./announcement-data";

const announcementTemplate = "GG! Get whitelisted at theuncsgaming.com/whitelist. Thanks for playing on The UNCs.";

export function AnnouncementComposer({
  server,
  csrf,
  previewOnly,
}: {
  server: AdminServer;
  csrf: string;
  previewOnly: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const overviewPath = serverApiPath(server.id, "overview");
  const overview = useSWR(overviewPath, (path) => readAdminApi(path, announcementOverviewSchema), liveRefreshOptions);
  const trimmed = draft.trim();
  const length = trimmed.length;
  const overLimit = length > 200;
  const singleLine = [...trimmed].every((character) => character.charCodeAt(0) >= 32);
  const hasAccess = server.role === "admin" || server.role === "moderator";
  const freshOverview = isOverviewFresh(overview.data);
  const canBroadcast = hasBroadcastRoute(overview.data?.capabilities.routes ?? []);
  const canReview = Boolean(
    trimmed &&
    !overLimit &&
    singleLine &&
    hasAccess &&
    csrf &&
    !previewOnly &&
    freshOverview &&
    !overview.error &&
    canBroadcast,
  );

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canReview) setReviewMessage(trimmed);
  }

  return (
    <>
      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="border-b px-4 py-4 pb-4 sm:px-6">
          <CardTitle>In-game announcement</CardTitle>
          <CardDescription>Everyone connected sees it. Review the message before it sends.</CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-6">
          <form className="grid gap-4" onSubmit={review}>
            <label htmlFor="announcement-message" className="grid gap-2 text-sm font-medium">
              Message
              <Textarea
                id="announcement-message"
                value={draft}
                rows={3}
                placeholder="Write an announcement…"
                aria-describedby="announcement-count"
                aria-invalid={overLimit || !singleLine || undefined}
                onChange={(event) => setDraft(event.currentTarget.value.replace(/[\r\n]+/g, " "))}
              />
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={() => setDraft(announcementTemplate)}>
                Use template
              </Button>
              {draft ? (
                <Button type="button" variant="ghost" onClick={() => setDraft("")}>
                  Clear
                </Button>
              ) : null}
              <span
                id="announcement-count"
                className={`ml-auto text-sm tabular-nums ${overLimit ? "text-destructive" : "text-muted-foreground"}`}
                aria-live="polite"
              >
                {length} / 200{overLimit ? ` · ${length - 200} over the limit` : ""}
              </span>
            </div>

            {draft && !singleLine ? <p className="text-sm text-destructive">Use a single-line announcement.</p> : null}

            {overview.error && !overview.data ? (
              <Alert variant="destructive">
                <AlertTitle>Live player count unavailable</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                  <span>Refresh the overview before sending an announcement.</span>
                  <Button type="button" size="sm" variant="outline" onClick={() => void overview.mutate()}>
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : overview.error ? (
              <Alert>
                <AlertTitle>Player count refresh failed</AlertTitle>
                <AlertDescription>
                  The last count is shown, but announcements are paused until the server refreshes.
                </AlertDescription>
              </Alert>
            ) : null}

            {!hasAccess ? (
              <p className="text-sm text-muted-foreground">
                Sending announcements requires moderator or administrator access.
              </p>
            ) : previewOnly ? (
              <p className="text-sm text-muted-foreground">
                Sample game data is read-only; announcements cannot be sent.
              </p>
            ) : overview.data && !canBroadcast ? (
              <p className="text-sm text-muted-foreground">This server build does not support in-game announcements.</p>
            ) : overview.data && !freshOverview ? (
              <p className="text-sm text-muted-foreground">Waiting for a fresh server check before sending.</p>
            ) : !overview.data && !overview.error ? (
              <p className="text-sm text-muted-foreground">Checking the live player count and server support…</p>
            ) : null}

            <Button type="submit" className="w-fit" disabled={!canReview}>
              <SendIcon data-icon="inline-start" />
              {typeof overview.data?.status.players.current === "number"
                ? `Send to ${overview.data.status.players.current} ${overview.data.status.players.current === 1 ? "player" : "players"}`
                : "Review announcement"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {reviewMessage !== null ? (
        <AnnouncementReviewDialog
          server={server}
          csrf={csrf}
          message={reviewMessage}
          playerCount={overview.data?.status.players.current}
          allowed={canReview}
          onStarted={() => setDraft("")}
          onRefresh={() => void overview.mutate()}
          onEdit={(message) => setDraft(message)}
          onClose={() => setReviewMessage(null)}
        />
      ) : null}
    </>
  );
}
