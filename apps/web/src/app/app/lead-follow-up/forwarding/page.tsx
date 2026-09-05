import { redirect } from "next/navigation";
import { moduleHref } from "@eva/types";

/**
 * The Forwarding page moved into the Mailbox tab on 2026-09-05 (founder:
 * *"it should be on mailbox tab.. with a short step by step guide"*).
 *
 * ⚠️ THE ADDRESS STAYS AND REDIRECTS RATHER THAN 404s. It was linked from the
 * enquiry book's address card for two weeks, and a bookmark or an old tab is
 * still somebody's way in. `app-links.spec.ts` counts this file as a real
 * route for the same reason.
 */
export default function ForwardingSetupPage() {
  redirect(moduleHref("lead_follow_up", "mailbox"));
}
