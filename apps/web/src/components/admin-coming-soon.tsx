type AdminComingSoonProps = {
  group: string;
  title: string;
};

export function AdminComingSoon({ group, title }: AdminComingSoonProps) {
  return (
    <section className="flex flex-col gap-2 p-6" aria-labelledby="section-title">
      <p className="font-mono text-xs font-medium tracking-widest text-muted-foreground uppercase">{group}</p>
      <h1 id="section-title" className="text-3xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="text-sm text-muted-foreground">This section is coming soon.</p>
    </section>
  );
}
