import Link from "next/link";

/**
 * The pieces every screen is built from (2026-08-09 design handoff).
 *
 * ⚠️ SHARED SO THE PRODUCT LOOKS LIKE ONE PRODUCT. Five screens each inventing
 * their own card is how a design becomes five designs — the borders drift, the
 * radii drift, and a year later nobody can say which one is right. One card
 * here, changed once.
 *
 * Hook-free and directive-free so they can be rendered in a plain node test.
 */

/** The white surface everything sits on. */
export function Card({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-[var(--radius-card)] border border-border bg-surface ${className}`.trim()}
    >
      {children}
    </div>
  );
}

/** A section title, with an optional link on the right of the same line. */
export function SectionHeading({
  title,
  action,
}: {
  title: string;
  action?: { href: string; label: string; tone?: "link" | "danger" } | undefined;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-sm font-bold">{title}</h2>
      {action && (
        <Link
          href={action.href}
          className={`text-[13px] font-semibold hover:underline ${
            action.tone === "danger" ? "text-danger" : "text-link"
          }`}
        >
          {action.label} →
        </Link>
      )}
    </div>
  );
}

/**
 * A status, as a tinted pill.
 *
 * ⚠️ THE TONE IS DECORATION; THE WORD IS THE MEANING. Every pill carries its
 * own label, because colour alone is unreadable to anyone who cannot separate
 * red from amber — and "Didn't send" and "Waiting" are exactly the two a
 * customer must never confuse.
 */
const PILL_TONES = {
  good: "bg-success-tint text-success",
  warn: "bg-warning-tint text-warning-strong",
  bad: "bg-danger-tint text-danger",
  mute: "bg-neutral-tint text-muted-foreground",
} as const;

export type PillTone = keyof typeof PILL_TONES;

export function StatusPill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-block rounded-[var(--radius-pill)] px-2.5 py-[3px] text-[11.5px] font-semibold ${PILL_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Something that needs a person, with its severity on the left edge.
 *
 * ⚠️ THE ACTION IS PART OF THE CARD, NOT AN AFTERTHOUGHT. Telling somebody a
 * thing is broken without telling them where to go is how a dashboard becomes
 * an anxiety generator.
 */
export function AlertCard({
  tone,
  headline,
  detail,
  action,
}: {
  tone: "bad" | "warn";
  headline: string;
  detail: string;
  action?: { href: string; label: string } | undefined;
}) {
  const bad = tone === "bad";
  return (
    <div
      className={`flex min-w-[380px] flex-1 items-center gap-3.5 rounded-[var(--radius-card)] border border-l-[3px] px-4.5 py-3.5 ${
        bad
          ? "border-danger-border border-l-danger bg-danger-surface"
          : "border-warning-border border-l-warning bg-warning-tint"
      }`}
    >
      <span
        aria-hidden
        className={`flex size-8 shrink-0 items-center justify-center rounded-full text-base font-bold ${
          bad ? "bg-danger-tint text-danger" : "bg-warning-border text-warning-strong"
        }`}
      >
        !
      </span>
      <span className="flex flex-1 flex-col gap-px">
        <span className={`text-[13.5px] font-bold ${bad ? "text-danger" : "text-warning-strong"}`}>
          {headline}
        </span>
        <span className="text-[12.5px] text-muted-foreground">{detail}</span>
      </span>
      {action && (
        <Link
          href={action.href}
          className={`text-[12.5px] font-semibold whitespace-nowrap hover:underline ${
            bad ? "text-danger" : "text-warning-strong"
          }`}
        >
          {action.label} →
        </Link>
      )}
    </div>
  );
}

/**
 * Nothing here yet — and that is not a failure.
 *
 * ⚠️ DASHED, NOT SOLID. A solid empty card reads as a thing that failed to
 * load; a dashed outline reads as a space waiting to be filled. The difference
 * matters most on a customer's very first screen, which is exactly when they
 * are deciding whether this thing works.
 */
export function EmptyState({
  headline,
  detail,
  children,
}: {
  headline: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[var(--radius-card)] border border-dashed border-neutral-border px-6 py-8">
      <span className="text-[15px] font-semibold">{headline}</span>
      <p className="max-w-xl text-[13px] text-muted-foreground">{detail}</p>
      {children && <div className="flex flex-wrap gap-3 pt-1">{children}</div>}
    </div>
  );
}

/** The one primary action on a screen. */
export function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-[var(--radius-control)] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-[var(--shadow-primary)] hover:opacity-90"
    >
      {children}
    </Link>
  );
}

/** A secondary action: same weight of decision, less weight of ink. */
export function GhostLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-[var(--radius-control)] border border-input-border bg-surface px-4 py-2 text-[13px] font-semibold hover:bg-chip-hover"
    >
      {children}
    </Link>
  );
}
