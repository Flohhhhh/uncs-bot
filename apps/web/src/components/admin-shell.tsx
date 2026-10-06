"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { AdminSidebar, ServerSelectionPrompt } from "~/components/admin-sidebar";
import { AdminServerProvider } from "~/components/admin-server-context";
import { BackendStatus } from "~/components/backend-status";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "~/components/ui/sidebar";
import { adminServerListSchema, type AdminServer, type AdminServerList } from "~/lib/admin-servers";
import type { Staff } from "~/lib/session/schema";

const LEGACY_SERVER_ID = "primary";

export function AdminShell({ user, children }: { user: Staff; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const [serverList, setServerList] = useState<AdminServerList | null>(null);
  const [serverLoading, setServerLoading] = useState(true);
  const [serverError, setServerError] = useState<string | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    void fetch("/admin/api/servers", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) {
          void response.body?.cancel().catch(() => {});
          router.replace(response.status === 401 ? "/sign-in" : "/access-denied");
          return null;
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new Error("The game server list could not be loaded.");
        }

        const parsed = adminServerListSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("The game server list could not be verified.");
        return parsed.data;
      })
      .then((result) => {
        if (controller.signal.aborted || !result) return;
        setServerList(result);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setServerList(null);
        setServerError(
          error instanceof Error && error.name === "TimeoutError"
            ? "The game server list took too long to respond."
            : "The game server list could not be loaded. Try again.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setServerLoading(false);
      });

    return () => controller.abort();
  }, [requestVersion, router]);

  const requestedServerId = searchParams.get("server");
  const selectedServerId = requestedServerId ?? (serverList?.legacy ? LEGACY_SERVER_ID : null);
  const selectedServer: AdminServer | null =
    serverList?.servers.find((server) => server.id === selectedServerId) ?? null;
  const invalidSelection = requestedServerId !== null && selectedServer === null;

  function retryServerList() {
    setServerLoading(true);
    setServerError(null);
    setServerList(null);
    setRequestVersion((version) => version + 1);
  }

  const selectServer = useCallback(
    (id: string) => {
      const params = new URLSearchParams(search);
      params.set("server", id);
      router.push(`${pathname}?${params.toString()}`);
    },
    [pathname, router, search],
  );

  return (
    <SidebarProvider defaultOpen>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:shadow"
      >
        Skip to content
      </a>
      <AdminSidebar
        user={user}
        serverList={serverList}
        selectedServer={selectedServer}
        serverLoading={serverLoading}
        serverError={serverError}
        pathname={pathname}
        search={search}
        onSelectServer={selectServer}
      />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-3 border-b bg-background px-3 sm:px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <span className="truncate text-sm font-medium text-muted-foreground">The UNCs Admin</span>
          <div className="ml-auto min-w-0">
            <BackendStatus user={user} />
          </div>
        </header>
        <main id="main-content" className="flex min-h-0 flex-1 flex-col">
          {serverLoading ? (
            <p role="status" className="p-6 text-sm text-muted-foreground">
              Loading game servers…
            </p>
          ) : serverError ? (
            <section className="flex min-h-72 flex-col items-start justify-center gap-3 p-6" role="alert">
              <h1 className="text-2xl font-semibold tracking-tight">Server list unavailable</h1>
              <p className="max-w-lg text-sm text-muted-foreground">{serverError}</p>
              <Button variant="outline" onClick={retryServerList}>
                Retry
              </Button>
            </section>
          ) : !serverList ? (
            <p role="status" className="p-6 text-sm text-muted-foreground">
              Loading game servers…
            </p>
          ) : !selectedServer ? (
            <ServerSelectionPrompt serverList={serverList} invalid={invalidSelection} />
          ) : (
            <AdminServerProvider server={selectedServer} gameMode={user.gameMode}>
              {children}
            </AdminServerProvider>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
