import type { ProductManifest } from "../../platform/registry/product-manifest.js";

/**
 * Lead Follow-up — an enquiry arrives, Eva reads it, files it, and answers it
 * as the customer, from the customer's own account.
 *
 * ⚠️ THE NAME LOST "BY EMAIL" ON 2026-09-02 (founder ruling 62), three days
 * before the code caught up. The rename came first because a product key is
 * structural (a database CHECK, a folder, a URL) and costs one migration
 * against one row, versus a migration against live customer rows later. Since
 * 3.4a (2026-09-05) Eva receives and answers on email AND WhatsApp; Messenger
 * and Instagram are the next slices.
 *
 * **A "mailbox" in this folder is still literally a mailbox**, and a "number"
 * is a WhatsApp number. What was generalised when the second channel landed
 * was the PORT — `OUTBOUND_MAIL` gained a twin, `OUTBOUND_MESSAGE`, each in
 * its own capability — not the word. The reply service asks "which medium?"
 * once and then speaks to exactly one of them.
 *
 * ⚠️ THIS FOLDER DID NOT EXIST UNTIL SLICE 3.1c-1, AND ITS ABSENCE WAS CORRECT.
 * Everything the product did up to 3.1b was either the LEAD RECORD (platform —
 * shared with Lead Follow-up by Call and the CRM, ruling 56) or RECEIVING MAIL
 * (the mailbox capability — the same kind of thing as sending it, 3.1b). A
 * product folder whose only content is a call into the platform is a folder
 * pretending to be a boundary, so there was nothing to put here.
 *
 * What finally belongs to the product is ANSWERING, and the first piece of it
 * is the words: `lead_reply_templates`, the wording a customer edits for
 * themselves.
 *
 * ⚠️ ONE TABLE, AND RESIST ADDING THE LEAD TO IT. Ownership is exclusive
 * (`architecture.spec.ts`), so listing `lead` here would lock Lead Follow-up by
 * CALL — a separate purchase, ruling 14 — and the planned CRM out of the
 * enquiry book for good. That trap was proposed once and caught; the reasoning
 * is in `table-ownership.ts` beside `lead`.
 */
export const LEAD_FOLLOW_UP: ProductManifest = {
  key: "lead_follow_up",
  /**
   * ⚠️ BOTH ARE ABOUT THE REPLY, WHICH IS THE WHOLE OF WHAT THIS PRODUCT
   * OWNS. `leadReplyTemplate` is the words a customer may send;
   * `leadReplyDecision` is what happened to one enquiry — the verdict, and the
   * message if there was one. The LEAD itself stays platform (ruling 56), so
   * Lead Follow-up by Call and the CRM can still read the enquiry book.
   */
  tables: ["leadReplyTemplate", "leadReplyDecision"],
};
