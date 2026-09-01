import type { ProductManifest } from "../../platform/registry/product-manifest.js";

/**
 * Lead Follow-up by Email — an enquiry arrives at an address we own, Eva reads
 * it, files it, and answers it from the customer's own mailbox.
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
export const LEAD_FOLLOW_UP_EMAIL: ProductManifest = {
  key: "lead_follow_up_email",
  tables: ["leadReplyTemplate"],
};
