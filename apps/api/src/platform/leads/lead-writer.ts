/**
 * What every way of making a lead shares (slice 3.3b).
 *
 * Two writers exist — an email delivery and a channel message — and a third
 * (the hand-logged lead) survives without a screen. They agree on three
 * things: how much of the message is quoted onto the lead, what a created
 * lead reports back, and which spine rows the lead must be pinned to.
 */

/**
 * How much of the message is quoted onto the lead.
 *
 * ⚠️ THE WHOLE MESSAGE IS NOT LOST BY THIS — it is on the raw delivery row and
 * on `messages`, complete. `lead_evidence.raw_excerpt` is named an excerpt and
 * is one; the lead's `enquiry` matches the 4,000 the API contract has always
 * accepted, so a lead made by email and a lead made any other way hold the
 * same shape of thing.
 */
export const EXCERPT_LIMIT = 4000;

/** Trimmed and capped, or null when there is nothing to quote. */
export function excerpt(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, EXCERPT_LIMIT);
}

export interface CreatedLead {
  id: string;
}

/**
 * Where on the spine a new enquiry hangs (migration 0041, rulings 66/67/75).
 *
 * ⚠️ REQUIRED, NOT OPTIONAL. The three columns are nullable in the database
 * only so that enquiries arriving between 0041 and this deploy did not fail;
 * from this slice every writer supplies them, which is what lets a later
 * migration make `pipeline_stage_id` NOT NULL. A writer that "will set them
 * later" is how a column nothing sets comes about (the `endsAt` trap).
 */
export interface LeadSpine {
  /** The person this enquiry is from. */
  personId: string;
  /** Always the organisation's `new` stage for an enquiry that just arrived. */
  pipelineStageId: string;
  /** The thread the enquiry opened, when it arrived as a message. */
  originConversationId: string | null;
}
