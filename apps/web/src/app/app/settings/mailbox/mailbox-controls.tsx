"use client";

import { useActionState, useState } from "react";
import type { MailboxSummary } from "@/components/mailbox-card";
import { PrimarySubmit } from "@/components/ui";
import { replaceMessage } from "@/capabilities/mailbox/mailbox-messages";
import {
  connectMailbox,
  disconnectMailbox,
  sendTestEmail,
  setPrimaryMailbox,
  type MailboxActionState,
} from "../actions";

const INITIAL_STATE: MailboxActionState = {};

const SMALL_BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-muted px-3 py-1.5 text-xs font-medium hover:opacity-80 disabled:opacity-60";
const DANGER_BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-danger px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60";

/**
 * Per-mailbox actions (slice 1.6a). Every one carries the mailbox id, which is
 * the whole point of the change: with seats, "the" mailbox no longer
 * identifies anything, and an action that re-finds one could act on the wrong
 * mailbox entirely.
 */
export function MailboxActions({
  organisationId,
  mailbox,
  canPromote,
}: {
  organisationId: string;
  mailbox: MailboxSummary;
  /** Only meaningful with more than one mailbox connected. */
  canPromote: boolean;
}) {
  const [disconnectState, disconnectAction, disconnectPending] = useActionState(
    disconnectMailbox,
    INITIAL_STATE,
  );
  const [testState, testAction, testPending] = useActionState(sendTestEmail, INITIAL_STATE);
  const [primaryState, primaryAction, primaryPending] = useActionState(
    setPrimaryMailbox,
    INITIAL_STATE,
  );
  // Two-step confirm rather than window.confirm(): a native modal blocks the
  // page for browser automation (the e2e drives this button), and an inline
  // step states the consequence where the user is looking.
  const [confirming, setConfirming] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const filed = mailbox.allocatedClientCount ?? 0;

  const hidden = (
    <>
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="mailboxId" value={mailbox.id} />
    </>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <form action={testAction}>
          {hidden}
          <button type="submit" disabled={testPending} className={SMALL_BUTTON_CLASS}>
            {testPending ? "Sending…" : "Send test email"}
          </button>
        </form>
        {canPromote && !mailbox.isPrimary && (
          <form action={primaryAction}>
            {hidden}
            <button type="submit" disabled={primaryPending} className={SMALL_BUTTON_CLASS}>
              {primaryPending ? "Switching…" : "Make this the default"}
            </button>
          </form>
        )}
        {/* Its own affordance, visually apart from Disconnect (ruling 3).
            "Disconnect then reconnect" is NOT the same thing: it drops every
            allocation to the default in the gap and tells nobody. */}
        {!replacing && !confirming && (
          <button type="button" onClick={() => setReplacing(true)} className={SMALL_BUTTON_CLASS}>
            Replace this address
          </button>
        )}
        {!confirming && !replacing && (
          <button type="button" onClick={() => setConfirming(true)} className={SMALL_BUTTON_CLASS}>
            Disconnect
          </button>
        )}
      </div>

      {replacing && (
        <div className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-muted p-3">
          {/* One interpolated value, no JSX text node — Next drops the space
              between `{expression}` and wrapped JSX text (toolchain note). */}
          <p className="text-sm">
            {replaceMessage(mailbox.emailAddress, filed, mailbox.isPrimary)}
          </p>
          <ConnectMailboxForm
            organisationId={organisationId}
            replacesMailboxId={mailbox.id}
            label="Sign in to the new mailbox"
          />
          <div>
            <button
              type="button"
              onClick={() => setReplacing(false)}
              className={SMALL_BUTTON_CLASS}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <div className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-muted p-3">
          <p className="text-sm">
            Disconnect <span className="font-medium">{mailbox.emailAddress}</span>?
            {/* Gated on there actually BEING another mailbox. `canPromote` was
                already passed in and ignored here, so a single-mailbox
                organisation was promised a fallback that does not exist — and
                the truth is the opposite: everything stops. */}
            {mailbox.isPrimary &&
              canPromote &&
              " Eva will send from your next oldest mailbox instead."}
          </p>
          {!canPromote && (
            <p className="text-sm text-danger">
              This is your only mailbox. Eva will have nowhere to send from and will stop chasing
              everyone until you connect another.
            </p>
          )}
          {/* Say the cost BEFORE the click, not only after it. Someone
              disconnecting to tidy up needs to know a book of clients moves. */}
          {filed > 0 && (
            <p className="text-sm text-danger">
              {`${filed === 1 ? "1 client is" : `${filed} clients are`} filed under it and will be chased from your default mailbox instead. Use Replace this address to keep them together.`}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <form action={disconnectAction}>
              {hidden}
              <button type="submit" disabled={disconnectPending} className={DANGER_BUTTON_CLASS}>
                {disconnectPending ? "Disconnecting…" : "Yes, disconnect"}
              </button>
            </form>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={disconnectPending}
              className={SMALL_BUTTON_CLASS}
            >
              Keep it
            </button>
          </div>
        </div>
      )}

      {[disconnectState, testState, primaryState].map(
        (state, index) =>
          (state.error ?? state.success) && (
            <p
              key={index}
              role={state.error ? "alert" : "status"}
              className={`text-sm ${state.error ? "text-danger" : "text-success"}`}
            >
              {state.error ?? state.success}
            </p>
          ),
      )}
    </div>
  );
}

/** The connect form. Hidden entirely when every seat is taken — sending
 *  someone to Microsoft to grant Eva access and THEN telling them it was
 *  pointless is the worst version of this. */
/**
 * ⚠️ THE PROVIDER CHOICE LIVES HERE TOO, AND FORGETTING IT WOULD HAVE SHIPPED
 * GMAIL THAT NOBODY EXISTING COULD REACH (3.1b step 3). The onboarding step has
 * always had a provider picker; this form never needed one, because there was
 * only ever Microsoft. Adding Gmail to onboarding alone would mean it worked
 * for customers signing up TODAY and was invisible to every customer who
 * already had an account — including the only one we have.
 *
 * Caught by reading rather than by a test, which is the uncomfortable part:
 * nothing failed, because "the settings page does not offer Gmail" is a missing
 * feature, and a missing feature has no test to break.
 */
const CONNECT_PROVIDERS = [
  { id: "microsoft", name: "Outlook", hint: "Outlook, Hotmail or Microsoft 365" },
  { id: "google", name: "Gmail", hint: "Gmail or Google Workspace" },
] as const;

export function ConnectMailboxForm({
  organisationId,
  defaultAddress,
  label,
  replacesMailboxId,
}: {
  organisationId: string;
  defaultAddress?: string | null;
  label?: string;
  /** Set by Replace this address (slice 1.6b). Rides the signed OAuth state, so
   *  the callback can carry the old mailbox's clients across. */
  replacesMailboxId?: string;
}) {
  const [provider, setProvider] = useState<"microsoft" | "google">("microsoft");
  const chosen = CONNECT_PROVIDERS.find((option) => option.id === provider)!;
  const destination = provider === "google" ? "Google" : "Microsoft";

  return (
    <form action={connectMailbox} className="flex flex-col gap-3">
      <input type="hidden" name="organisationId" value={organisationId} />
      {/* Rides the signed OAuth state so the return lands back here rather than
          in the setup flow. */}
      <input type="hidden" name="flow" value="settings" />

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">Where do you send email from?</legend>
        <div className="flex flex-wrap gap-2 pt-1">
          {CONNECT_PROVIDERS.map((option) => (
            <label
              key={option.id}
              className={`cursor-pointer rounded-[var(--radius-card)] px-3.5 py-2 text-sm ${
                provider === option.id
                  ? "border-2 border-primary bg-selected-tint font-medium"
                  : "border border-border hover:bg-chip-hover"
              }`}
            >
              <input
                type="radio"
                name="provider"
                value={option.id}
                checked={provider === option.id}
                onChange={() => setProvider(option.id)}
                className="sr-only"
              />
              {option.name}
            </label>
          ))}
        </div>
      </fieldset>
      {replacesMailboxId && (
        <input type="hidden" name="replacesMailboxId" value={replacesMailboxId} />
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor="emailAddress" className="text-sm font-medium">
          Which mailbox?
        </label>
        <input
          id="emailAddress"
          name="emailAddress"
          type="email"
          autoComplete="email"
          defaultValue={defaultAddress ?? ""}
          placeholder="you@yourcompany.co.uk"
          className="w-full max-w-sm rounded-[var(--radius-card)] border border-muted-foreground/30 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
        {/* ⚠️ NAMES THE PROVIDER THE CUSTOMER ACTUALLY PICKED. "You'll sign in at
            Microsoft" under a Gmail choice is the small wrongness that makes
            somebody stop and wonder what else is wrong — and it is the sort of
            sentence that stays false for months because nothing tests copy. */}
        <p className="text-xs text-muted-foreground">
          {chosen.hint}. You&apos;ll sign in at {destination} — Eva never sees your password.
        </p>
      </div>
      <div>
        <PrimarySubmit>{label ?? `Connect ${chosen.name} mailbox`}</PrimarySubmit>
      </div>
    </form>
  );
}
