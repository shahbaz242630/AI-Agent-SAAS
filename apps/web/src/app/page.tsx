import { HealthBadge } from "@eva/ui";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <p className="text-sm font-medium tracking-widest text-muted-foreground uppercase">
        AI Business Communications Platform
      </p>
      <h1 className="text-5xl font-bold text-primary">Eva</h1>
      <p className="max-w-xl text-lg text-muted-foreground">
        Practical AI employee for UK small businesses — invoice chasing, lead follow-up and AI
        reception, built module by module.
      </p>
      <div className="rounded-[var(--radius-card)] bg-muted px-6 py-3 text-sm">
        <HealthBadge />
      </div>
    </main>
  );
}
