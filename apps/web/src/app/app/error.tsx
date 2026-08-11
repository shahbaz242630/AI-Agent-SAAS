"use client";

import { PrimaryButton } from "@/components/ui";

/**
 * What a signed-in screen shows when something under it fails.
 *
 * ⚠️ BEFORE THIS FILE, ELEVEN OF THE TWELVE SCREENS ANSWERED A FAILURE WITH A
 * CRASH. Any error thrown while rendering — an API that is down, a 409 we wrote
 * a careful sentence for, a bug — went past every boundary to Next's own error
 * page: a stack trace in development, and a bare "Application error" in
 * production. Found on 2026-08-11 by opening the invoices screen while the
 * account was in a state the API answers 409 to.
 *
 * ⚠️ THE SHELL SURVIVES, AND THAT IS THE POINT OF PUTTING THIS HERE RATHER THAN
 * AT THE ROOT. A route-level boundary replaces only the screen, so the sidebar
 * stays: somebody who hits a broken Invoices page can still click Home, Clients
 * or Settings and carry on. `global-error.tsx` at the root replaces the entire
 * document and is the last resort, not this one.
 *
 * ⚠️ THE DETAIL IS `digest`, NOT `error.message`, AND THAT IS NOT LAZINESS.
 * React strips server error messages before they reach the browser in
 * production — deliberately, because they can carry internals — leaving only a
 * short hash that appears in the server log beside the failure. So the hash is
 * the useful thing to show: it is what turns "it broke" into a line we can
 * find. The same role the API's correlation id plays, from the other side.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex w-full max-w-[1080px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
      <h1 className="font-display text-[29px] font-semibold">Something went wrong</h1>
      <p className="max-w-[560px] text-sm text-muted-foreground">
        This screen couldn&apos;t load. Nothing you have done is lost — your invoices, clients and
        anything Eva has scheduled are untouched. Try again in a moment.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        {/* React's own retry: re-renders the segment without a full page load,
            which is the right first move for a failure that was transient. */}
        <PrimaryButton type="button" onClick={reset}>
          Try again
        </PrimaryButton>
      </div>

      {error.digest && (
        <p className="text-[13px] text-faint">
          Reference: <span className="font-mono">{error.digest}</span>
        </p>
      )}
    </main>
  );
}
