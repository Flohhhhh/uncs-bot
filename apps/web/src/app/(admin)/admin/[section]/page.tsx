import type { Metadata } from "next";
import { notFound } from "next/navigation";

const sections = {
  players: { label: "Players", group: "Live" },
  match: { label: "Match & maps", group: "Live" },
  activity: { label: "Server activity", group: "Live" },
  whitelist: { label: "Whitelist", group: "Community" },
  applications: { label: "Applications", group: "Community" },
  bans: { label: "Bans", group: "Community" },
  announcements: { label: "Announcements", group: "Community" },
  supporters: { label: "Supporters", group: "Community" },
  "discord-roles": { label: "Discord roles", group: "Community" },
  settings: { label: "Settings", group: "Server" },
} as const;

type SectionSlug = keyof typeof sections;

function getSection(slug: string) {
  return Object.hasOwn(sections, slug) ? sections[slug as SectionSlug] : null;
}

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }): Promise<Metadata> {
  const { section } = await params;
  const page = getSection(section);
  return { title: `${page?.label ?? "Admin"} · The UNCs` };
}

export default async function AdminSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const page = getSection(section);
  if (!page) notFound();

  return (
    <section className="flex flex-col gap-2 p-6" aria-labelledby="section-title">
      <p className="font-mono text-xs font-medium tracking-widest text-muted-foreground uppercase">{page.group}</p>
      <h1 id="section-title" className="text-3xl font-semibold tracking-tight">
        {page.label}
      </h1>
      <p className="text-sm text-muted-foreground">This section is coming soon.</p>
    </section>
  );
}
