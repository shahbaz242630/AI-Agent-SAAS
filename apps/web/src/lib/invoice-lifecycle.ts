/**
 * The four lifecycle actions, and what each one costs (slice 1.6c, task 4).
 *
 * A pure module in `lib` for the `mailbox-messages.ts` reason: every sentence
 * here is a promise about what happens to somebody's debtor after a click, and
 * this project has shipped copy that was TRUE and implied something false. Here
 * the promises are testable without rendering a page.
 *
 * ⚠️ EVERY SENTENCE BELOW WAS CHECKED AGAINST `reminder-scheduler.ts`, NOT
 * GUESSED. Pausing does not hold a schedule, it cancels it. Resuming does not
 * pick up where it left off, it recomputes from today. Activating an overdue
 * invoice does not fire every missed reminder, it collapses them into one. A
 * button whose label is right and whose consequence is wrong is the 1.6b
 * disconnect defect again.
 */

/** The four actions the API's state machine exposes. */
export type InvoiceLifecycleAction = "activate" | "pause" | "resume" | "cancel";

const LIFECYCLE_ACTIONS: readonly InvoiceLifecycleAction[] = [
  "activate",
  "pause",
  "resume",
  "cancel",
];

/**
 * Which stored statuses each action is legal from — a mirror of `ACTIONS` in
 * the api's `invoice-state-machine.ts`.
 *
 * A mirror, and NOT the authority: the API refuses an illegal transition with a
 * 409 whether or not this agrees, because a server action is reachable by
 * direct POST. This exists so the screen does not offer a button that can only
 * fail — trap 4 — and the drift risk is small and self-announcing (a wrong
 * entry here shows up as a 409 the moment anyone clicks it).
 */
const LEGAL_FROM: Readonly<Record<InvoiceLifecycleAction, readonly string[]>> = {
  activate: ["draft"],
  pause: ["active"],
  resume: ["paused"],
  cancel: ["draft", "active", "paused"],
};

/**
 * The three statuses the API DERIVES, all of which mean the invoice is stored
 * as `active`.
 *
 * ⚠️ THIS MAPPING IS THE WHOLE POINT, and it removes a trap rather than
 * documenting one. An overdue invoice's `displayStatus` is `overdue` and its
 * `status` is `active`; a screen that asked for actions using the status it had
 * just put on the badge would offer NOTHING on exactly the invoices most likely
 * to need pausing. Normalising here means both fields give the same, correct
 * answer, so the caller cannot pick the wrong one.
 */
const DERIVED_FROM_ACTIVE = new Set(["due_soon", "due_today", "overdue"]);

/** The stored status behind a status that may have been derived for display. */
export function storedStatusOf(status: string): string {
  return DERIVED_FROM_ACTIVE.has(status) ? "active" : status;
}

/**
 * Which actions this invoice can actually take, in the order they should be
 * offered. Empty for `cancelled`, `paid` and the rest — those are resting
 * states with no legal move, and an empty list is the honest answer.
 */
export function availableInvoiceActions(status: string): InvoiceLifecycleAction[] {
  const stored = storedStatusOf(status);
  return LIFECYCLE_ACTIONS.filter((action) => LEGAL_FROM[action].includes(stored));
}

/** Narrows a string off a form to an action, for the server action's own guard. */
export function isInvoiceLifecycleAction(value: string): value is InvoiceLifecycleAction {
  return (LIFECYCLE_ACTIONS as readonly string[]).includes(value);
}

/**
 * The button. Phrased as what happens to the CHASE rather than to the record —
 * "Activate" is our word for it, "Start chasing" is what it does to a debtor.
 */
const ACTION_LABELS: Readonly<Record<InvoiceLifecycleAction, string>> = {
  activate: "Start chasing",
  pause: "Pause chasing",
  resume: "Resume chasing",
  cancel: "Cancel invoice",
};

export function invoiceActionLabel(action: InvoiceLifecycleAction): string {
  return ACTION_LABELS[action];
}

/** The confirm button inside the panel — it repeats the verb, never "OK". */
const CONFIRM_LABELS: Readonly<Record<InvoiceLifecycleAction, string>> = {
  activate: "Yes, start chasing",
  pause: "Yes, pause it",
  resume: "Yes, resume chasing",
  cancel: "Yes, cancel it",
};

export function invoiceActionConfirmLabel(action: InvoiceLifecycleAction): string {
  return CONFIRM_LABELS[action];
}

/** Only `cancel` cannot be undone, and only it gets the danger styling. */
export function isInvoiceActionIrreversible(action: InvoiceLifecycleAction): boolean {
  return action === "cancel";
}

/**
 * The two actions that START a chase, and therefore need a clear path to email.
 *
 * ⚠️ RESUME BELONGS HERE AS MUCH AS ACTIVATE. Both call the scheduler, both
 * schedule exactly zero reminders when nothing can be sent, and both report
 * success either way. It was tempting to treat this as an "activating a new
 * invoice" problem — it is not; the same silence follows a resume.
 */
function startsChasing(action: InvoiceLifecycleAction): boolean {
  return action === "activate" || action === "resume";
}

/**
 * WHY Eva cannot email a reminder, as half a sentence.
 *
 * The API sends the reason (`chaseBlockedReason`) rather than a message,
 * because the reasons are the SCHEDULER's own — `checkReminderEligibility`
 * plus "no working mailbox" — and a screen that invented its own list would
 * drift from the thing that actually decides. The words are ours; the facts
 * are the server's.
 *
 * Written as a clause rather than a sentence so one phrase serves all three
 * places it is needed: on the row, before the click, and afterwards. Three
 * copies of "the contact has no email address" would eventually disagree.
 */
const BLOCKED_PHRASES: Readonly<Record<string, string>> = {
  no_contact: "nobody is set to receive reminders",
  contact_deleted: "the person it was addressed to has been removed",
  no_email: "the contact has no email address",
  suppressed: "that contact has asked not to be emailed",
  no_mailbox: "no working mailbox is connected",
};

function blockedPhrase(reason: string | null): string | null {
  if (reason === null) return null;
  // An unknown reason still says something true. The web app can be older than
  // the API it is talking to, and "Eva can't chase this" with no explanation is
  // far better than silently claiming everything is fine.
  return BLOCKED_PHRASES[reason] ?? "something is stopping it";
}

/**
 * The line shown on an invoice row when Eva cannot chase it — null when there
 * is nothing worth saying.
 *
 * ⚠️ IT NEEDS THE STATUS, AND THE FIRST VERSION DID NOT TAKE IT. Because
 * `chaseBlockedReason` sets the invoice's own status aside, an organisation
 * with no mailbox reports `no_mailbox` on EVERY invoice — so the row for a
 * settled invoice read "Paid · Eva can't chase this — no working mailbox is
 * connected." Nobody wants to chase a paid invoice. The warning is only worth
 * making when the invoice's status says Eva is supposed to be chasing it;
 * anywhere else the badge beside it has already explained why she is not.
 *
 * Seen on screen on 2026-08-04, one commit after a doc comment in this very
 * file claimed the behaviour it did not implement.
 */
export function chaseBlockedLine(status: string, reason: string | null): string | null {
  if (storedStatusOf(status) !== "active") return null;
  const phrase = blockedPhrase(reason);
  return phrase === null ? null : `Eva can't chase this — ${phrase}.`;
}

/**
 * Is Eva actually chasing this invoice right now?
 *
 * BOTH halves are required, and this is the function that stops a screen
 * implying otherwise: an invoice is chased when its status is Active AND
 * nothing blocks the send. A cancelled invoice with a good contact is not being
 * chased; nor is an active one whose contact has no email address.
 *
 * Used to decide whether an outstanding balance is money Eva is working on —
 * which is why a CANCELLED invoice must not show its balance as though it were.
 */
export function isBeingChased(status: string, chaseBlockedReason: string | null): boolean {
  return storedStatusOf(status) === "active" && chaseBlockedReason === null;
}

/**
 * What will happen, said BEFORE the click (the 1.6b disconnect precedent).
 *
 * `chaseBlockedReason` changes the two chasing branches, because an invoice
 * nothing can be sent for is not chased at all: the scheduler refuses it and
 * writes zero rows. It still succeeds and still says Active — so without this
 * the screen would report a chase that was never going to happen, which is the
 * failure mode this project has shipped twice.
 *
 * ⚠️ IT TOOK THE SERVER'S REASON, NOT A FLAG. The first version asked only
 * "does it have a recipient", which is one of FIVE ways a chase silently does
 * not happen — the others being a removed contact, a contact with no email
 * address, one who asked not to be emailed, and an organisation with no working
 * mailbox. In four of the five the screen said "Eva will chase it" and nothing
 * was ever sent.
 */
export function invoiceActionConsequence(
  action: InvoiceLifecycleAction,
  invoice: { invoiceNumber: string; chaseBlockedReason: string | null },
): string {
  const number = invoice.invoiceNumber;
  const phrase = blockedPhrase(invoice.chaseBlockedReason);
  if (startsChasing(action) && phrase !== null) {
    return `${number} will not actually be chased — ${phrase}. You can start it now and put that right afterwards, but until you do, nothing will be sent.`;
  }
  switch (action) {
    case "activate":
      // The default sequence's FIRST email is three days BEFORE the due date,
      // so "from its due date" would be wrong in the direction that matters:
      // the client hears from Eva while the invoice is still current.
      return `Eva will start chasing ${number} on your reminder schedule, which by default emails the client three days before the due date. If it is already overdue, the reminders it has missed collapse into a single catch-up email rather than all going out at once.`;
    case "pause":
      // "Cancelled rather than held" is the fact people get wrong. The rows are
      // not paused; they are cancelled, and resuming builds new ones.
      return `Eva stops chasing ${number} straight away, and the reminders already queued for it are cancelled rather than held. You can resume later — but it starts a fresh schedule instead of picking up where this one stopped.`;
    case "resume":
      return `Eva starts chasing ${number} again and works out a fresh schedule from today. Anything that fell due while it was paused is not sent late — it becomes a single catch-up reminder.`;
    case "cancel":
      // ⚠️ "cannot be undone" is literal: the state machine has no transition
      // out of cancelled, in any direction. And the paid/cancelled distinction
      // is the reason the label is not "Close" (trap 7).
      return `Eva stops chasing ${number} for good and cancels every reminder queued for it. This cannot be undone — a cancelled invoice cannot be started again. Cancelled is not the same as paid, so do not use it to record that this one was settled.`;
  }
}

/**
 * What it says afterwards — stating the outcome, not "Done".
 *
 * ⚠️ THE BLOCKED REASON IS NOT OPTIONAL DECORATION, and leaving it out produced
 * a defect on screen within a minute of the feature working. The confirm panel
 * warned "nobody is set to receive reminders … nothing will be sent", the
 * activation succeeded, and this line then said "Eva will chase it on your
 * reminder schedule" — contradicting the warning we had just given, on an
 * invoice with zero reminders queued (checked in the database, not on the
 * screen). A warning a product overrules one click later is worse than no
 * warning: it teaches people to ignore the next one.
 *
 * The caller reads it from the API's OWN response to the transition, never from
 * a hidden field — the browser should not be the source of truth for whether
 * somebody is going to be emailed.
 */
export function invoiceActionSuccess(
  action: InvoiceLifecycleAction,
  invoiceNumber: string,
  /* Required, with no default: a default would be a decision about somebody's
     customer being emailed, made by whoever forgot to pass it. */
  invoice: { chaseBlockedReason: string | null },
): string {
  const phrase = blockedPhrase(invoice.chaseBlockedReason);
  if (startsChasing(action) && phrase !== null) {
    return `${invoiceNumber} is active, but nothing will be sent — ${phrase}.`;
  }
  switch (action) {
    case "activate":
      return `${invoiceNumber} is active. Eva will chase it on your reminder schedule.`;
    case "pause":
      return `${invoiceNumber} is paused. Eva has stopped chasing it.`;
    case "resume":
      return `${invoiceNumber} is active again, on a fresh schedule from today.`;
    case "cancel":
      return `${invoiceNumber} is cancelled. Eva will not chase it again.`;
  }
}
