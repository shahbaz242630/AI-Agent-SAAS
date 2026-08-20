import { redirect } from "next/navigation";
import { moduleHref } from "@eva/types";

/**
 * The product's front door (Slice 3.1a).
 *
 * ⚠️ IT EXISTS BECAUSE THE HUB WILL LINK IT, AND IT REDIRECTS BECAUSE THERE IS
 * NOTHING TO PUT HERE YET. `hubGroups` sends a customer to `moduleHref(key)` —
 * the product root — the moment the product goes live, and a root with no page
 * behind it is the bare Next 404 the founder walked into on production on
 * 2026-08-19. Building it now costs one file; discovering it missing costs a
 * customer their way in.
 *
 * ⚠️ AND THE BOOK IS AT `/enquiries` RATHER THAN HERE, DELIBERATELY. Putting it
 * at the root would be less code today and a route move at 3.1c, when this
 * becomes a real dashboard (what Eva answered, how fast, what is waiting on a
 * human). Moving a route is exactly what left 29 dead links behind on
 * 2026-08-19 — so the book goes to its permanent address first time.
 */
export default function LeadFollowUpHomePage() {
  redirect(moduleHref("lead_follow_up_email", "enquiries"));
}
