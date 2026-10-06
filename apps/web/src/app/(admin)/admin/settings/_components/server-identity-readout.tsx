"use client";

import { useState } from "react";
import useSWR from "swr";
import { CheckIcon, CopyIcon, RefreshCwIcon } from "lucide-react";

import { readAdminApi, serverApiPath } from "~/components/overview/overview-data";
import { Button } from "~/components/ui/button";
import type { AdminServer } from "~/lib/admin-servers";
import { settingsRefreshOptions, serverIdentitySchema } from "./settings-data";

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <code className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{value}</code>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Copy server ID" onClick={() => void copy()}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Server ID copied" : ""}
      </span>
    </span>
  );
}

export function ServerIdentityReadout({ server }: { server: AdminServer }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="rounded-md border px-4 py-3 sm:col-span-2 sm:px-5"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-semibold">Server ID &amp; current banner</summary>
      {open ? <IdentityDetails server={server} /> : null}
    </details>
  );
}

function IdentityDetails({ server }: { server: AdminServer }) {
  const path = serverApiPath(server.id, "server-identity");
  const identity = useSWR(path, (url) => readAdminApi(url, serverIdentitySchema), settingsRefreshOptions);
  const serverId = identity.data?.serverId;
  const banner = identity.data?.banner;

  function missing(value: typeof serverId) {
    return value?.error || (!value ? "Unavailable" : !value.available ? "Not provided by this build" : "Not set");
  }

  return (
    <div className="mt-4 grid gap-4" aria-busy={identity.isLoading}>
      {identity.error && !identity.data ? (
        <p role="alert" className="text-sm text-destructive">
          Server identity could not be loaded.
        </p>
      ) : !identity.data ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading server identity…
        </p>
      ) : (
        <>
          {identity.error ? (
            <p className="text-sm text-muted-foreground" role="status">
              Identity could not be refreshed. Showing the last loaded values.
            </p>
          ) : null}
          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="grid min-w-0 gap-1">
              <dt className="text-xs font-medium text-muted-foreground">Server ID</dt>
              <dd className="min-w-0 text-sm">
                {serverId?.value ? <CopyValue value={serverId.value} /> : missing(serverId)}
              </dd>
            </div>
            <div className="grid min-w-0 gap-1">
              <dt className="text-xs font-medium text-muted-foreground">Current banner</dt>
              <dd className="min-w-0 text-sm">
                {banner?.value ? (
                  <a
                    className="text-orange-400 underline-offset-4 hover:underline"
                    href={banner.value}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open reported image ↗
                  </a>
                ) : (
                  missing(banner)
                )}
              </dd>
            </div>
          </dl>
        </>
      )}
      <p className="text-sm text-muted-foreground">
        Reported by the running game. The saved banner URL is shown below.
      </p>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={identity.isValidating}
          onClick={() => void identity.mutate()}
        >
          <RefreshCwIcon data-icon="inline-start" />
          Refresh identity
        </Button>
      </div>
    </div>
  );
}
