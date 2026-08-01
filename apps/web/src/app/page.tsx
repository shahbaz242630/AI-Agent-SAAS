import Link from "next/link";
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

      {/* Until this existed, /sign-in and /sign-up had to be typed by hand —
          found during the 1.6 e2e, and the first thing a real visitor would
          have looked for. */}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/sign-up"
          className="rounded-[var(--radius-card)] bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground"
        >
          Get started
        </Link>
        <Link
          href="/sign-in"
          className="rounded-[var(--radius-card)] bg-muted px-5 py-2.5 text-sm font-medium hover:opacity-80"
        >
          Sign in
        </Link>
      </div>

      <div className="rounded-[var(--radius-card)] bg-muted px-6 py-3 text-sm">
        <HealthBadge />
      </div>
    </main>
  );
}
