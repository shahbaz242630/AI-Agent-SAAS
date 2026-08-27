/**
 * WHO EVA WRITES TO — the one answer, for every reader (founder, 2026-08-27).
 *
 * 🚨 THIS FILE EXISTS BECAUSE THE ANSWER USED TO BE GIVEN IN FOUR PLACES.
 * `reminder-eligibility` decided whether to schedule, `reminder-actions`
 * decided what to check suppression against, `reminder-sender` decided what to
 * put in the `To:` header, and `chase-blockers` decided what to tell the person
 * reading the book. All four independently said "the contact's email", and the
 * failure mode of that agreement is silent: any one of them drifting means Eva
 * schedules for one address and sends to another, or the screen promises a
 * chase the sender refuses.
 *
 * ⚠️ THE CLIENT'S OWN EMAIL IS NOW A REAL FALLBACK, AND THAT IS THE CHANGE.
 * Founder, 2026-08-27, on being shown that the upload screen advertised four
 * address columns: *"why do we have contact email and client email twice? …no
 * need to duplicate"*. It was worse than duplication — `customers.email` was
 * written by the importer, printed on the clients list, and read by NOTHING.
 * So the most natural column for a small business to fill in was the one that
 * did nothing, and a perfectly ordinary spreadsheet imported clean, reported
 * "5 ready", and produced five invoices Eva would never send.
 *
 * The founder chose the version that removes the duplication rather than
 * hiding it: one address per level, no second copy to drift. A named contact
 * still wins when there is one — that is the whole point of naming a person at
 * a bigger client — and the client's own address catches the sole trader who
 * IS the contact.
 *
 * ⚠️ FALLING BACK IS DELIBERATE EVEN WHEN THE CONTACT WAS DELETED. Removing a
 * person is not the same as forgiving a debt, and the client's address is still
 * good. Suppression is the way to stop a chase, and it is checked separately
 * against whatever address this returns.
 */

/** What a caller must load to get an answer. Both may be absent. */
export interface RecipientCandidates {
  contact: { id: string; deletedAt: Date | null; email: string | null; name: string } | null;
  customer: { id: string; email: string | null } | null;
}

export interface ResolvedRecipient {
  /** The address Eva will actually send to. Never empty. */
  email: string;
  /**
   * The name for the greeting, or null for the neutral opener.
   *
   * ⚠️ NULL ON THE CLIENT FALLBACK, ON PURPOSE. `reminder-message.ts` turns a
   * name into "Hi Sarah," and nothing into "Hello,". A client's name is a
   * BUSINESS name as often as a person's, and "Hi Kerrison Joinery Ltd," in a
   * letter chasing money reads like a mail-merge that went wrong — over our
   * customer's name, to their customer. Nothing here can tell a sole trader's
   * name from a limited company's, so the fallback takes the opener that is
   * never wrong instead of the one that is usually right.
   */
  name: string | null;
  /**
   * Which of the two answered. `chase-blockers` needs it to say something
   * useful, and it is worth having in a log when a chase surprises somebody.
   */
  via: "contact" | "customer";
  /**
   * 🚨 THE KEY THE 3-DAY SPACING LOCK MUST USE, AND IT IS NOT THE CONTACT ID
   * ANY MORE. `reminder-actions` takes `pg_advisory_xact_lock(hashtext(...))`
   * so two invoices for the same person cannot be scheduled a day apart (BRD
   * 4.1). It keyed on `contact.id`, which does not exist on the fallback path —
   * so without this, every client chased via their own address would have taken
   * a lock on nothing and the spacing invariant would silently stop holding for
   * exactly the customers this change added.
   */
  spacingKey: string;
}

/**
 * The contact when it can receive mail, else the client, else nobody.
 *
 * Pure: callers load the rows and check suppression against the address this
 * returns. It answers WHO, never WHETHER — status, suppression and the mailbox
 * are the other gates' business.
 */
export function resolveRecipient(input: RecipientCandidates): ResolvedRecipient | null {
  const contact = input.contact;
  if (contact !== null && contact.deletedAt === null && hasAddress(contact.email)) {
    return {
      email: contact.email!.trim(),
      name: contact.name,
      via: "contact",
      spacingKey: `contact:${contact.id}`,
    };
  }
  const customer = input.customer;
  if (customer !== null && hasAddress(customer.email)) {
    return {
      email: customer.email!.trim(),
      name: null,
      via: "customer",
      spacingKey: `customer:${customer.id}`,
    };
  }
  return null;
}

/** Empty-after-trim counts as absent — a cleared form field stores "" not null. */
function hasAddress(email: string | null): boolean {
  return email !== null && email.trim() !== "";
}
