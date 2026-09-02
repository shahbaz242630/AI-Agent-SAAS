"use client";

import { useActionState, useState } from "react";
import {
  answerForwardingRequest,
  startForwardingSetup,
  type ForwardingActionState,
} from "./actions";
import { unexpectedRequestSentence } from "@/capabilities/mailbox/forwarding-guide";

const INITIAL_STATE: ForwardingActionState = {};

const BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60";
const SMALL_BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-muted px-3 py-1.5 text-xs font-medium hover:opacity-80 disabled:opacity-60";
const DANGER_BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-danger px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60";

/** One request, as the API describes it. */
export interface ForwardingRequestRow {
  id: string;
  sourceAddress: string;
  status: "pending" | "confirmed" | "declined";
  failureReason: string | null;
  confirmUrl: string | null;
  confirmedAutomatically: boolean | null;
  requestedAt: string;
}

/** The button that opens the window in which Eva answers Google for them. */
export function StartSetupButton({ organisationId }: { organisationId: string }) {
  const [state, action, pending] = useActionState(startForwardingSetup, INITIAL_STATE);

  return (
    <div className="flex flex-col gap-2">
      <form action={action}>
        <input type="hidden" name="organisationId" value={organisationId} />
        <button type="submit" disabled={pending} className={BUTTON_CLASS}>
          {pending ? "Getting ready…" : "I'm setting this up now"}
        </button>
      </form>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.success && <p className="text-sm text-muted-foreground">{state.success}</p>}
    </div>
  );
}

/**
 * A request Eva would not answer by itself.
 *
 * ⚠️ THE DECLINE BUTTON IS NOT A DESTRUCTIVE ACTION DRESSED IN RED FOR DRAMA.
 * Turning a request down is the safe answer and the reversible-by-asking-again
 * one; CONFIRMING is the choice that starts a stranger's mail arriving. So the
 * confirm button carries the two-step, not the decline.
 */
export function ForwardingRequestActions({
  organisationId,
  request,
}: {
  organisationId: string;
  request: ForwardingRequestRow;
}) {
  const [state, action, pending] = useActionState(answerForwardingRequest, INITIAL_STATE);
  // Two-step rather than window.confirm(): a native modal blocks the page for
  // browser automation, and an inline step states the consequence where the
  // person is already looking.
  const [confirming, setConfirming] = useState(false);

  const hidden = (
    <>
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="requestId" value={request.id} />
    </>
  );

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">{unexpectedRequestSentence(request.sourceAddress)}</p>

      {confirming ? (
        <div className="flex flex-col gap-2">
          <p className="text-[12.5px] text-muted-foreground">
            {`Everything ${request.sourceAddress} receives will start arriving here as enquiries. Only do this if you set it up.`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <form action={action}>
              {hidden}
              <input type="hidden" name="decision" value="confirm" />
              <button type="submit" disabled={pending} className={SMALL_BUTTON_CLASS}>
                {pending ? "Confirming…" : "Yes, that was me"}
              </button>
            </form>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className={SMALL_BUTTON_CLASS}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className={SMALL_BUTTON_CLASS}
            disabled={pending}
          >
            That was me
          </button>
          <form action={action}>
            {hidden}
            <input type="hidden" name="decision" value="decline" />
            <button type="submit" disabled={pending} className={DANGER_BUTTON_CLASS}>
              {pending ? "Working…" : "That wasn't me"}
            </button>
          </form>
        </div>
      )}

      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.success && <p className="text-sm text-muted-foreground">{state.success}</p>}

      {/**
       * ⚠️ THE ONLY FALLBACK THERE IS, BECAUSE GOOGLE STOPPED SENDING A CODE.
       * Measured on the real message: there is no confirmation code in the
       * subject or the body. So when Eva cannot answer Google, the honest offer
       * is the link itself — shown only once an attempt has actually failed,
       * because putting it here unconditionally would undercut the whole point
       * of the feature.
       */}
      {request.failureReason && request.confirmUrl && (
        <p className="text-[12.5px] text-muted-foreground">
          <a
            href={request.confirmUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-link hover:underline"
          >
            Open Google&apos;s confirmation page yourself
          </a>{" "}
          — it does the same thing, in your own browser.
        </p>
      )}
    </div>
  );
}
