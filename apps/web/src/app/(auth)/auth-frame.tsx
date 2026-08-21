import Link from "next/link";

/**
 * The split screen every auth page shares (2026-08-09 design handoff).
 *
 * Paper on the left with the form, charcoal on the right with the reason to
 * bother. Hook-free and directive-free so `renderToStaticMarkup` can reach it —
 * the `SidebarBody` and `OnboardingFrame` precedent.
 *
 * ⚠️ THE RIGHT PANEL STATES NO FACTS ABOUT A CUSTOMER, AND THE PROTOTYPE'S DID.
 * The design draws "14 reminders sent · 3 waiting", "Second reminder ·
 * INV-2041", and "Next scheduled run: tomorrow, 9:00 — 3 reminders due to go
 * out for Fenwick Joinery". Those are prototype furniture. On a real sign-in
 * page nobody is signed in yet, so numbers presented in that position read as
 * YOUR numbers — invented ones, on the screen where a customer is deciding
 * whether this product tells the truth. Same ruling as the testimonials: it is
 * not ours to make up. Every line below is a statement about how Eva behaves,
 * which is true for everyone and needs no session to say.
 */

export interface AuthPanel {
  headline: string;
  /** One paragraph, where the panel is a statement rather than a list. */
  lead?: string;
  /** Amber-dash promises. */
  bullets?: readonly string[];
  /** The same promises as separate tiles, where the design draws cards. */
  cards?: readonly string[];
}

export function AuthFrame({
  panel,
  back,
  children,
}: {
  panel: AuthPanel;
  /** Where "← Back" goes, and nothing renders if there is nowhere sensible. */
  back?: { href: string; label: string } | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-1 flex-col lg:flex-row">
      <div className="flex flex-1 flex-col bg-background px-10 py-7">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className="flex items-baseline gap-0.5 self-start">
            <span className="font-display text-[22px] font-bold">eva</span>
            <span aria-hidden className="size-1.5 rounded-full bg-accent" />
          </Link>
          {back && (
            <Link
              href={back.href}
              className="rounded-[var(--radius-pill)] border border-input-border bg-surface px-3.5 py-[7px] text-[12.5px] font-semibold text-label hover:bg-chip-hover"
            >
              ← {back.label}
            </Link>
          )}
        </div>
        <main className="flex flex-1 items-center justify-center py-10">
          <div className="flex w-[380px] max-w-full flex-col gap-5">{children}</div>
        </main>
      </div>

      {/*
       * ⚠️ HIDDEN BELOW `lg`, NOT STACKED. Stacked, the charcoal half becomes a
       * wall of reassurance a phone user must scroll past to reach the password
       * field — the one thing they came for. The panel is support for the form,
       * never a toll gate in front of it.
       */}
      <aside className="hidden flex-1 flex-col justify-center gap-7 bg-sidebar px-18 py-16 text-sidebar-body lg:flex">
        <h2 className="font-display text-[32px] leading-[1.15] font-semibold text-balance text-sidebar-foreground">
          {panel.headline}
        </h2>

        {panel.lead && (
          <p className="max-w-[380px] text-sm leading-[1.55] text-sidebar-muted">{panel.lead}</p>
        )}

        {panel.bullets && (
          <div className="flex flex-col gap-3.5">
            {panel.bullets.map((line) => (
              <p key={line} className="flex gap-2.5 text-sm leading-[1.5] text-sidebar-muted">
                <span aria-hidden className="text-accent">
                  —
                </span>
                {line}
              </p>
            ))}
          </div>
        )}

        {panel.cards && (
          <div className="flex max-w-[400px] flex-col gap-3">
            {panel.cards.map((line) => (
              <p
                key={line}
                className="flex items-center gap-3 rounded-xl border border-sidebar-border bg-sidebar-panel px-4.5 py-3.5 text-[13px] text-sidebar-body"
              >
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" />
                {line}
              </p>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

/**
 * The panels, kept together so the claims on them can be read in one place and
 * checked against what Eva actually does.
 */
export const AUTH_PANELS = {
  signUp: {
    headline: "Your invoices, chased politely while you work.",
    bullets: [
      "Eva sends from your own mailbox, so replies come straight back to you.",
      "You set when she chases; she asks for what's left, never the total.",
      "Every send is on the record — nothing happens silently.",
    ],
  },
  signIn: {
    headline: "While you were away, Eva kept chasing.",
    cards: [
      "Reminders go out on the schedule you set, whether or not you are here.",
      "She asks for what's left on an invoice, never the total.",
      "Every send is on the record, waiting for you.",
    ],
  },
  signedOut: {
    headline: "Go do the work. Eva does the chasing.",
    lead: "Reminders already scheduled still go out while you are away, on the schedule you set, and every one of them will be on the record when you are back.",
  },
  changePassword: {
    headline: "Your account, locked tight.",
    bullets: [
      /**
       * ⚠️ THE DESIGN'S FIRST BULLET WAS "Changing your password signs out your
       * other devices." IT IS NOT HERE BECAUSE NOBODY HAS CHECKED WHETHER IT IS
       * TRUE. Whether Supabase revokes other sessions on a password change is a
       * project setting, and a security promise is the last sentence in a
       * product that should be taken on trust — somebody reading it might
       * reasonably decide NOT to go and sign out a lost phone. What replaces it
       * describes this form, which is verifiable by looking at it.
       */
      "You'll need your current password first — that is what proves it is you.",
      // Named the provider until 3.1b. It is now Microsoft OR Google, and
      // "your email provider" is true of both without listing them on a screen
      // about changing a password.
      "Your mailbox connection is separate — it stays connected at your email provider.",
    ],
  },
  resetPassword: {
    headline: "Locked out, not left out.",
    lead: "While you reset, Eva keeps working — reminders already scheduled go out as planned.",
  },
} as const satisfies Record<string, AuthPanel>;

/** The heading block every auth screen opens with. */
export function AuthHeading({ title, subtitle }: { title: string; subtitle: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="font-display text-[26px] leading-tight font-semibold">{title}</h1>
      <p className="text-[13.5px] leading-[1.55] text-muted-foreground">{subtitle}</p>
    </div>
  );
}

/**
 * The green tick that says a thing finished.
 *
 * ⚠️ IT IS DECORATION AND THE WORDS ARE THE MEANING — the heading beside it
 * always says what happened, because a tick alone is unreadable to anyone who
 * cannot see it.
 */
export function SuccessDisc({ tone = "good" }: { tone?: "good" | "sent" }) {
  return (
    <span
      aria-hidden
      className={`flex size-11 items-center justify-center rounded-full text-xl font-bold ${
        tone === "sent" ? "bg-warning-tint text-warning-strong" : "bg-success-tint text-success"
      }`}
    >
      {tone === "sent" ? "✉" : "✓"}
    </span>
  );
}

/**
 * The one action on the screen, full width.
 *
 * ⚠️ WIDER AND TALLER THAN THE APP'S BUTTONS ON PURPOSE. An auth screen has a
 * single thing to do and a 380px column to do it in; the dashboard's compact
 * control would read as one option among several on a page that offers none.
 */
export function AuthSubmit({
  pending,
  children,
}: {
  pending?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="cursor-pointer rounded-[var(--radius-control)] bg-primary px-4 py-[13px] text-center text-[14.5px] font-semibold text-primary-foreground shadow-[var(--shadow-primary)] hover:opacity-90 disabled:cursor-default disabled:opacity-60"
    >
      {children}
    </button>
  );
}

/** Its outlined twin, for the second destination on a terminal screen. */
export function AuthOutlineLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-[var(--radius-control)] border border-input-border bg-surface px-4 py-[13px] text-center text-[14.5px] font-semibold hover:bg-chip-hover"
    >
      {children}
    </Link>
  );
}

/** Its filled twin, where the primary action is a link rather than a submit. */
export function AuthPrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-[var(--radius-control)] bg-primary px-4 py-[13px] text-center text-[14.5px] font-semibold text-primary-foreground shadow-[var(--shadow-primary)] hover:opacity-90"
    >
      {children}
    </Link>
  );
}

/** A refusal or a failure, said in words rather than in red alone. */
export function AuthError({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-[var(--radius-control)] border border-danger-border bg-danger-surface px-3.5 py-2.5 text-[13px] text-danger"
    >
      {children}
    </p>
  );
}

/** The field pattern shared by every auth form. */
export function AuthField({
  id,
  label,
  aside,
  ...input
}: {
  id: string;
  label: string;
  /** A link on the label's line — "Forgot your password?". */
  aside?: React.ReactNode;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-semibold">
          {label}
        </label>
        {aside}
      </div>
      <input
        id={id}
        {...input}
        className="w-full rounded-[var(--radius-control)] border border-input-border bg-surface px-3.5 py-[11px] text-sm outline-none focus:border-primary"
      />
    </div>
  );
}
