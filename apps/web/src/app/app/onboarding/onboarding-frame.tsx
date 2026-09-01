import Link from "next/link";

/**
 * The frame setup lives in (2026-08-09 design handoff).
 *
 * ⚠️ THE RAIL IS THE POINT, NOT THE DECORATION. The old screen was a three-bar
 * progress strip above a grey box: a customer on step one could see that a step
 * two existed but not what it would ask of them, so a request for access to
 * their email arrived unannounced — the single moment in this product most
 * likely to make somebody stop. Naming each step, and what it is for, is what
 * turns it into something expected.
 *
 * ⚠️ IT ASKED FOR A MAILBOX AS STEP TWO UNTIL 2026-09-01, AND NO LONGER DOES.
 * A mailbox belongs to ONE product (ruling 36), and onboarding runs before a
 * customer has chosen one — so the step had no product to connect for and could
 * only have guessed. Founder ruling: drop it. You connect a mailbox inside the
 * product that will use it, at the moment you turn that product on.
 *
 * ⚠️ THE STEP IS A PROP, NOT A HOOK — the `SidebarBody` move for the same
 * reason. Which disc is a green tick and which is the amber one is the thing on
 * this screen that can be wrong without LOOKING wrong, so it has to be reachable
 * from a plain node test. `page.tsx` still derives the number from server state;
 * this component only draws what it is told.
 *
 * Hook-free and directive-free so `renderToStaticMarkup` needs no DOM.
 */

/**
 * The flow, in the rail's words.
 *
 * ⚠️ THE CAPTIONS ARE PROMISES ABOUT WHAT IS COMING, so they are written for
 * someone who has not read them yet. "Where Eva sends from" is what makes step
 * two make sense before it is reached.
 */
const STEPS: readonly { label: string; caption: string | null }[] = [
  { label: "Your business", caption: "What should we call you?" },
  { label: "Done", caption: null },
];

/**
 * The two things worth knowing before handing a product access to your email.
 * Pinned to the bottom of the rail on every step, because the question they
 * answer is asked at the end, not the beginning.
 */
const REASSURANCES: readonly string[] = [
  "Eva sends from your own mailbox, never a third-party address.",
  "You set when Eva chases, and she never chases more than what's left.",
];

export function OnboardingFrame({
  current,
  organisationName,
  email,
  signOutSlot,
  paneTitle,
  children,
}: {
  /** 1 = name the business, 2 = finished. */
  current: 1 | 2;
  /** Named back in the rail once it exists, so step one shows its own answer. */
  organisationName: string | null;
  /** Which account this is — the same question the sidebar's user card answers,
   *  asked here because there is no sidebar during setup. */
  email: string;
  /**
   * The sign-out control, passed in rather than built here: it is a form bound
   * to a server action, and a server action cannot be constructed in a plain
   * test. The `SidebarBody` precedent — the one unrenderable piece is the one
   * piece this component does not own.
   */
  signOutSlot: React.ReactNode;
  paneTitle: string;
  children: React.ReactNode;
}) {
  /**
   * ⚠️ "BACK" CANNOT MEAN "THE PREVIOUS STEP" HERE, AND THE DESIGN ASSUMED IT
   * COULD. The prototype sends a later step back to step one — but this flow
   * reads its position from server state, and once past step one the
   * organisation exists. There is no endpoint that renames one and no screen
   * that offers to, so a back link would either lie or need somewhere to undo
   * to. It leaves setup instead, which is the only honest thing it can do.
   *
   * On the last step setup is over and the pane offers a real destination, so
   * another one pointing outwards would just be a way to lose them.
   */
  const backHref = current === 2 ? null : "/";

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 px-9 py-[22px]">
        <Link href="/" className="flex items-baseline gap-0.5">
          <span className="font-display text-[22px] font-bold">eva</span>
          <span aria-hidden className="size-1.5 rounded-full bg-accent" />
        </Link>
        <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-faint">
          {backHref && (
            <Link
              href={backHref}
              className="rounded-[var(--radius-pill)] border border-input-border bg-surface px-3.5 py-[7px] font-semibold text-label hover:bg-chip-hover"
            >
              ← Back
            </Link>
          )}
          {/* A div rather than a paragraph: the slot is a form, and a form
              inside a <p> is invalid HTML the browser silently rearranges. */}
          <div className="flex items-center gap-1">
            <span>Signed in as {email} ·</span>
            {signOutSlot}
          </div>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-9 pb-11">
        {/*
         * ⚠️ IT STACKS BELOW `md`, AND THE DESIGN ONLY DRAWS IT WIDE. A 330px
         * rail beside a form does not fit a phone, and signing up on a phone is
         * exactly what someone does when a supplier recommends this over a
         * coffee. Stacked, the rail becomes a header that still names both
         * steps — which is the job it was added to do.
         */}
        <div className="flex w-[980px] max-w-full flex-col overflow-hidden rounded-[var(--radius-panel)] border border-border bg-surface shadow-[var(--shadow-panel)] md:flex-row">
          <aside className="flex shrink-0 flex-col gap-7 bg-sidebar px-8 py-9 text-sidebar-body md:w-[330px]">
            <div className="flex flex-col gap-2">
              <h1 className="font-display text-[26px] leading-tight font-semibold text-sidebar-foreground">
                Set up Eva
              </h1>
              {/**
               * ⚠️ IT SAID "TWO THINGS AND YOU'RE DONE" UNTIL 2026-09-01, AND
               * BY THEN THERE WAS ONE. Dropping the mailbox step left a count
               * that no longer matched the rail beside it — the exact defect
               * family as the "four settings screens" docblock, and found the
               * same way: by looking at the screen, not by a test.
               *
               * ⚠️ AND IT NAMED ONLY INVOICE CHASING. Setup now runs BEFORE a
               * product is chosen, so promising unpaid-invoice chasing to
               * somebody who came to buy Lead Follow-up describes a different
               * product than the one they are signing up for. What is true of
               * every product is that Eva works from their own mailbox.
               */}
              <p className="text-[13.5px] leading-[1.55] text-sidebar-muted">
                One question and you&apos;re in. Whatever you set Eva to do, she works from your own
                mailbox — so everything comes from your address and replies come straight back to
                you.
              </p>
            </div>

            <ol className="flex flex-col">
              {STEPS.map((step, index) => {
                const number = index + 1;
                const done = number < current;
                const active = number === current;
                const last = number === STEPS.length;
                // Once the business is named, step one stops asking the question
                // and starts showing the answer.
                const caption = number === 1 && organisationName ? organisationName : step.caption;
                return (
                  <li
                    key={step.label}
                    className="flex gap-3.5"
                    aria-current={active ? "step" : undefined}
                  >
                    <div className="flex flex-col items-center">
                      <span
                        aria-hidden
                        className={`flex size-[26px] shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                          done
                            ? "bg-module-live text-accent-foreground"
                            : active
                              ? "bg-accent text-accent-foreground shadow-[var(--shadow-step)]"
                              : "border-2 border-sidebar-border text-sidebar-faint"
                        }`}
                      >
                        {done ? "✓" : number}
                      </span>
                      {!last && (
                        <span aria-hidden className="min-h-[26px] w-0.5 flex-1 bg-sidebar-border" />
                      )}
                    </div>
                    <div className={`flex flex-col ${last ? "pt-1" : "pb-[22px]"}`}>
                      {/* Colour is how a sighted reader tells done from
                          upcoming, and colour alone is not an answer. */}
                      <span className="sr-only">
                        {done ? "Completed:" : active ? "Current step:" : "Not started:"}
                      </span>
                      <span
                        className={`text-[13.5px] font-semibold ${
                          done || active ? "text-sidebar-foreground" : "text-sidebar-faint"
                        }`}
                      >
                        {step.label}
                      </span>
                      {caption && (
                        <span
                          className={`text-[12px] ${
                            done || active ? "text-sidebar-faint" : "text-sidebar-fainter"
                          }`}
                        >
                          {caption}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>

            {/* Pushes the reassurances to the foot of the rail beside the form.
                Stacked, there is no form beside it to be as tall as, so the
                same spacer would open a band of empty charcoal instead. */}
            <div className="hidden flex-1 md:block" />

            <div className="flex flex-col gap-2.5 border-t border-sidebar-border pt-5">
              {REASSURANCES.map((line) => (
                <p
                  key={line}
                  className="flex gap-2.5 text-[12.5px] leading-[1.45] text-sidebar-muted"
                >
                  <span aria-hidden className="text-accent">
                    —
                  </span>
                  {line}
                </p>
              ))}
            </div>
          </aside>

          {/*
           * ⚠️ NO GAP HERE, AND THE STEP BELOW OWNS ITS OWN SPACING. The line
           * under this title is the step's QUESTION, and a question has to be
           * the real label of the thing it asks about — a `<label for>` on the
           * name field. That element belongs to the step's own form, so this
           * pane cannot render it; it would leave an input labelled by nothing
           * but proximity.
           */}
          <div className="flex min-w-0 flex-1 flex-col px-10 py-9">
            <h2 className="font-display text-[21px] font-semibold">{paneTitle}</h2>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
