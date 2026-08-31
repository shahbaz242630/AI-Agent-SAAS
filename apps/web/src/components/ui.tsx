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

/**
 * The frame every screen inside the app shell sits in.
 *
 * ⚠️ THIS EXACT CLASS STRING IS WRITTEN OUT IN FOURTEEN FILES (counted
 * 2026-08-30). It has not drifted yet, which is the only reason the product
 * still looks like one product — but fourteen hand-typed copies of a layout is
 * fourteen places to find when the page padding is wrong once, and the
 * fifteenth screen is written by copying whichever of them was open.
 *
 * Settings adopted it first; the remaining screens follow.
 */
export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex w-full max-w-[1080px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
      {children}
    </main>
  );
}

/**
 * The title block every screen opens with.
 *
 * ⚠️ THE SUBTITLE IS NOT DECORATION. Each one says what the screen is FOR in a
 * customer's words — "What Eva has done for Northgate", not "Reminders". It is
 * the difference between a product that explains itself and one that assumes
 * you already know the jargon.
 */
export function PageHeader({
  title,
  subtitle,
  aside,
  actions,
}: {
  title: string;
  subtitle: string;
  aside?: string | undefined;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-[29px] leading-tight font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
      {aside && <p className="pb-1 text-[13px] text-faint">{aside}</p>}
      {actions && <div className="flex flex-wrap items-center gap-3 pb-0.5">{actions}</div>}
    </header>
  );
}

/**
 * One blunt number with its own label.
 *
 * ⚠️ THE TONE IS ON THE NUMBER, NOT THE CARD. A whole card in red shouts even
 * when the number in it is 0 — and "0 didn't send" is the best news on the
 * screen. Colouring only the figure means the alarm scales with the value.
 */
export function CounterCard({
  value,
  label,
  sublabel,
  tone,
}: {
  value: number;
  label: string;
  sublabel: string;
  tone?: "warn" | "bad" | undefined;
}) {
  const emphasis = value > 0 ? tone : undefined;
  return (
    <Card className="flex flex-1 flex-col gap-0.5 px-5 py-4">
      <span
        className={`text-[30px] leading-tight font-bold ${
          emphasis === "bad" ? "text-danger" : emphasis === "warn" ? "text-warning-strong" : ""
        }`}
      >
        {value}
      </span>
      <span className="text-[13px] font-semibold">{label}</span>
      <span className="text-[12px] text-faint">{sublabel}</span>
    </Card>
  );
}

/**
 * The white surface everything sits on.
 *
 * ⚠️ SHARED WITH `Notice` BELOW, ON PURPOSE. They are the same surface and
 * differ only in what they wrap — a block of content, or one announced
 * sentence. Writing the border twice is how the edge of a confirmation drifts
 * from the edge of the card it sits above.
 */
const SURFACE = "rounded-[var(--radius-card)] border border-border bg-surface";

export function Card({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={`${SURFACE} ${className}`.trim()}>{children}</div>;
}

/**
 * Something that has just happened, said once, at the top of a screen.
 *
 * ⚠️ THIS WAS WRITTEN OUT FOUR TIMES IN ONE FILE BEFORE IT EXISTED — mailbox
 * settings said connected, disconnected, replace-degraded and failed in four
 * hand-typed copies of the same box. Four copies is four chances for the
 * padding to drift, and the next screen needing a confirmation would have made
 * five.
 *
 * ⚠️ THE TONE PICKS THE ARIA ROLE, AND THAT IS NOT COSMETIC. A failure has to
 * interrupt somebody using a screen reader (`alert`); a success must not
 * (`status`). Deriving it here means no caller has to remember the pairing —
 * the old copies got it right four times out of four and the fifth was a coin
 * toss.
 */
const NOTICE_TONES = {
  neutral: "",
  success: "text-success",
  muted: "text-muted-foreground",
  danger: "text-danger",
} as const;

export type NoticeTone = keyof typeof NOTICE_TONES;

export function Notice({
  tone = "neutral",
  children,
}: {
  tone?: NoticeTone;
  children: React.ReactNode;
}) {
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={`${SURFACE} px-6 py-3 text-sm ${NOTICE_TONES[tone]}`.trim()}
    >
      {children}
    </p>
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

/**
 * The ink of a primary control at dashboard size.
 *
 * ⚠️ SHARED BY THE LINK AND THE BUTTON BELOW ON PURPOSE. A screen whose two
 * actions are one link and one button — Invoices is exactly that — puts them
 * side by side, and two hand-written class lists drift by a pixel of padding
 * or a step of type and read as a mistake. `GhostLink` is the secondary half
 * of this pair and carries the same box.
 */
const PRIMARY_CONTROL =
  "rounded-[var(--radius-control)] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-[var(--shadow-primary)] hover:opacity-90";

/** The one primary action on a screen. */
export function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={PRIMARY_CONTROL}>
      {children}
    </Link>
  );
}

/**
 * The same primary action when it opens something in place rather than
 * navigating.
 *
 * ⚠️ `expanded` IS NOT DECORATION. This button is a disclosure — it reveals a
 * form below itself — and a sighted person can see that happen. Without
 * `aria-expanded` somebody using a screen reader is told only "button", clicks
 * it, and is given no reason to believe anything happened.
 *
 * ⚠️ `type="button"` IS LOAD-BEARING. This sits in the same row as controls
 * that belong to forms; the HTML default of "submit" would make it submit one.
 */
export function PrimaryAction({
  onClick,
  expanded,
  children,
}: {
  onClick: () => void;
  expanded?: boolean | undefined;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...(expanded === undefined ? {} : { "aria-expanded": expanded })}
      className={`cursor-pointer ${PRIMARY_CONTROL}`}
    >
      {children}
    </button>
  );
}

/**
 * The same primary action when it SUBMITS a form at dashboard size.
 *
 * ⚠️ THE GAP THIS FILLS IS WHY TWO "Save" BUTTONS DRIFTED APART. `PrimaryLink`
 * cannot submit, `PrimaryAction` is a disclosure that must keep `type="button"`,
 * and `PrimaryButton` below is deliberately LARGER — the one-thing-to-do button
 * for sign-in and setup. A dashboard form's Save had no component at all, so
 * Currency and Reminders each hand-wrote one and they came out different:
 * Reminders got the control radius, 13px, semibold and the shadow; Currency got
 * the CARD radius, `text-sm`, `font-medium`, no shadow and no hover at all.
 * Same word, same job, two visibly different buttons on sibling screens.
 *
 * ⚠️ `disabled` IS WIRED TO THE FORM'S PENDING STATE BY EVERY CALLER, and the
 * transition is what makes that read as a state rather than a flicker.
 */
export function PrimarySubmit({
  disabled,
  name,
  value,
  onClick,
  children,
}: {
  disabled?: boolean | undefined;
  /**
   * ⚠️ `name`/`value` CARRY AN INTENT, AND THAT IS LOAD-BEARING ON PRODUCTS.
   * One form there has three submits — save seats, turn on, turn off — and the
   * button that was pressed is the only thing that distinguishes them.
   */
  name?: string | undefined;
  value?: string | undefined;
  onClick?: (() => void) | undefined;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={disabled}
      {...(name === undefined ? {} : { name, value })}
      {...(onClick ? { onClick } : {})}
      className={`cursor-pointer ${PRIMARY_CONTROL} transition-opacity disabled:opacity-60`}
    >
      {children}
    </button>
  );
}

/**
 * The one primary action on a screen, when it submits a form rather than
 * following a link.
 *
 * ⚠️ SET LARGER THAN `PrimaryLink` ON PURPOSE. This is the button on a screen
 * that has exactly one thing to do — setup, sign-in — where the dashboard's
 * 13px control would read as one option among several. `disabled` is wired to
 * the form's pending state by every caller: minting an OAuth URL is a round
 * trip, and without it the button looks dead on the one click that matters
 * most.
 */
export function PrimaryButton({
  disabled,
  children,
  /**
   * ⚠️ DEFAULTS TO `submit` AND MUST KEEP DOING SO. Every existing use of this
   * button is the last control in a `<form>`, and a default of "button" would
   * silently stop those forms submitting — a change that renders identically
   * and breaks everything. Added 2026-08-11 for the app error boundary, whose
   * "Try again" calls React's `reset()` and belongs to no form at all.
   */
  type = "submit",
  onClick,
}: {
  disabled?: boolean | undefined;
  children: React.ReactNode;
  type?: "submit" | "button";
  onClick?: (() => void) | undefined;
}) {
  return (
    <button
      type={type}
      {...(onClick ? { onClick } : {})}
      disabled={disabled}
      className="cursor-pointer rounded-[var(--radius-control)] bg-primary px-[22px] py-[11px] text-sm font-semibold text-primary-foreground shadow-[var(--shadow-primary)] hover:opacity-90 disabled:cursor-default disabled:opacity-60"
    >
      {children}
    </button>
  );
}

/**
 * The way back out of a screen you stepped into.
 *
 * ⚠️ A CHIP, NOT A SENTENCE (founder, 2026-08-18: the upload screen's
 * *"Back to your invoices"* — muted grey text at the very bottom of the page —
 * *"looks like a write up not prominent"*). It was already a chip on the auth
 * pages and on onboarding, both of which hand-rolled the same class list. This
 * is that chip, in one place, so the third copy is an import rather than a
 * paste that drifts.
 *
 * ⚠️ IT BELONGS AT THE TOP OF THE SCREEN. Every other back control in the
 * product sits above the heading, which is where somebody looks when they want
 * out — not after the thing they were reading.
 */
export function BackChip({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex w-fit items-center gap-1.5 rounded-[var(--radius-pill)] border border-input-border bg-surface px-3.5 py-[7px] text-[12.5px] font-semibold text-label hover:bg-chip-hover"
    >
      <span aria-hidden>←</span>
      {children}
    </Link>
  );
}

/**
 * A secondary action: same weight of decision, less weight of ink.
 *
 * ⚠️ THE BOX IS SHARED WITH `GhostButton` AND SIZED FROM ONE PLACE. `md` is the
 * dashboard control, matching `PRIMARY_CONTROL` exactly so a primary and a
 * secondary in the same row are the same height; `sm` is the smaller disclosure
 * trigger that opens something inside a list row.
 */
const GHOST_CONTROL =
  "rounded-[var(--radius-control)] border border-input-border bg-surface font-semibold hover:bg-chip-hover";

const GHOST_SIZES = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-[13px]",
} as const;

export function GhostLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={`${GHOST_CONTROL} ${GHOST_SIZES.md}`}>
      {children}
    </Link>
  );
}

/**
 * The same secondary action when it does something in place rather than
 * navigating.
 *
 * ⚠️ IT EXISTS BECAUSE A CANCEL SAT BESIDE A PRIMARY AT A DIFFERENT HEIGHT.
 * Do not contact's correction form paired the LARGE `PrimaryButton`
 * (`py-[11px]`, `text-sm`) with a hand-written Cancel at `py-2`/`text-[13px]`,
 * in the same row — which is precisely the drift `PRIMARY_CONTROL` was written
 * to prevent, arriving by the one route it did not cover: a button nobody had
 * built, so somebody typed one.
 */
export function GhostButton({
  onClick,
  size = "md",
  children,
}: {
  onClick: () => void;
  size?: keyof typeof GHOST_SIZES;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer ${GHOST_CONTROL} ${GHOST_SIZES[size]}`}
    >
      {children}
    </button>
  );
}
