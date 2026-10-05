"use client";

import {
  ActivityIcon,
  ArrowUpRightIcon,
  BanIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  CircleDotIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  MailIcon,
  MapIcon,
  SettingsIcon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { StaffAccount } from "~/components/staff-account";
import { ThemeSelector } from "~/components/theme-selector";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "~/components/ui/sidebar";
import type { Staff } from "~/lib/session/schema";
import type { AdminServer, AdminServerList } from "~/lib/admin-servers";

const navigation = [
  {
    label: "Live",
    pages: [
      { label: "Overview", href: "/admin", icon: LayoutDashboardIcon },
      { label: "Players", href: "/admin/players", icon: UsersIcon },
      { label: "Match & maps", href: "/admin/match", icon: MapIcon },
      { label: "Server activity", href: "/admin/activity", icon: ActivityIcon },
    ],
  },
  {
    label: "Community",
    pages: [
      { label: "Whitelist", href: "/admin/whitelist", icon: ListChecksIcon },
      { label: "Applications", href: "/admin/applications", icon: MailIcon },
      { label: "Bans", href: "/admin/bans", icon: BanIcon },
      { label: "Announcements", href: "/admin/announcements", icon: ArrowUpRightIcon },
      { label: "Supporters", href: "/admin/supporters", icon: SparklesIcon },
      { label: "Discord roles", href: "/admin/discord-roles", icon: CircleDotIcon },
    ],
  },
  {
    label: "Server",
    pages: [{ label: "Settings", href: "/admin/settings", icon: SettingsIcon }],
  },
] as const;

type AdminSidebarProps = {
  user: Staff;
  serverList: AdminServerList | null;
  selectedServer: AdminServer | null;
  serverLoading: boolean;
  serverError: string | null;
  pathname: string;
  search: string;
  onSelectServer: (id: string) => void;
};

export function AdminSidebar(props: AdminSidebarProps) {
  const { isMobile, setOpenMobile } = useSidebar();
  const selectServer = (id: string) => {
    props.onSelectServer(id);
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="p-2">
        <ServerSwitcher {...props} onSelectServer={selectServer} />
      </SidebarHeader>

      <SidebarContent>
        {navigation.map((group) => (
          <SidebarGroup key={group.label} className="py-1">
            <SidebarGroupLabel className="h-7 px-2 text-[0.6875rem] font-semibold tracking-[0.14em] uppercase">
              {group.label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu aria-label={group.label}>
                {group.pages.map(({ label, href, icon: Icon }) => {
                  const active = props.pathname === href;
                  const search = props.search ? `?${props.search}` : "";

                  return (
                    <SidebarMenuItem key={href}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={label}
                        className="data-[active=true]:bg-sidebar-primary data-[active=true]:text-sidebar-primary-foreground data-[active=true]:hover:bg-sidebar-primary"
                      >
                        <Link
                          href={`${href}${search}`}
                          aria-current={active ? "page" : undefined}
                          onClick={() => {
                            if (isMobile) setOpenMobile(false);
                          }}
                        >
                          <Icon aria-hidden="true" />
                          <span>{label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="gap-1 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <ThemeSelector />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <StaffAccount user={props.user} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function ServerSwitcher({ serverList, selectedServer, serverLoading, serverError, onSelectServer }: AdminSidebarProps) {
  const { isMobile } = useSidebar();
  const serverLabel = serverLoading
    ? "Loading servers"
    : (selectedServer?.name ?? (serverError ? "Servers unavailable" : "Choose a server"));
  const serverRole = selectedServer?.role ?? "Game server";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              title={`${serverLabel} · The UNCs`}
              aria-label={`Server: ${serverLabel}`}
              disabled={serverLoading || !!serverError || !serverList?.servers.length}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <span
                aria-hidden="true"
                className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary font-mono text-sm font-bold text-sidebar-primary-foreground"
              >
                U
              </span>
              <span className="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate font-medium">{serverLabel}</span>
                <span className="truncate text-xs text-sidebar-foreground/70">{serverRole}</span>
              </span>
              <ChevronsUpDownIcon className="ml-auto group-data-[collapsible=icon]:hidden" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side={isMobile ? "bottom" : "right"}
            align="start"
            sideOffset={4}
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
          >
            <DropdownMenuLabel>Game servers</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {serverList?.servers.map((server) => (
              <DropdownMenuItem key={server.id} onSelect={() => onSelectServer(server.id)}>
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="truncate">{server.name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted-foreground">{server.role}</span>
                    {server.id === selectedServer?.id ? <CheckIcon aria-hidden="true" /> : null}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
            {serverList?.servers.length === 0 ? (
              <DropdownMenuItem disabled>No game servers available</DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function ServerSelectionPrompt({ serverList, invalid }: { serverList: AdminServerList; invalid: boolean }) {
  const { servers } = serverList;

  return (
    <section
      className="flex min-h-72 flex-col items-start justify-center gap-3 p-6"
      aria-labelledby="choose-server-title"
    >
      <h1 id="choose-server-title" className="text-2xl font-semibold tracking-tight">
        Choose a server
      </h1>
      <p className="max-w-lg text-sm text-muted-foreground">
        {invalid
          ? "That server is unavailable or outside your staff access. Choose a server you can manage."
          : "Select the server you want to manage from the switcher in the sidebar."}
      </p>
      {servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No game servers are available to this staff account.</p>
      ) : null}
    </section>
  );
}
