"use client";

import { useActionState, useState } from "react";
import type { MailboxSummary } from "@/components/mailbox-card";
import {
  connectMailbox,
  disconnectMailbox,
  sendTestEmail,
  setPrimaryMailbox,
  type MailboxActionState,
} from "../actions";

const INITIAL_STATE: MailboxActionState = {};

const BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60";
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
          <p className="text-sm">
            {filed > 0
              ? `Swap ${mailbox.emailAddress} for a different address. Its ${filed === 1 ? "client moves" : `${filed} clients move`} across, and so does its default status.`
              : `Swap ${mailbox.emailAddress} for a different address. Anything filed under it moves across.`}
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
export function ConnectMailboxForm({
  organisationId,
  defaultAddress,
  label = "Connect Outlook mailbox",
  replacesMailboxId,
}: {
  organisationId: string;
  defaultAddress?: string | null;
  label?: string;
  /** Set by Replace this address (slice 1.6b). Rides the signed OAuth state, so
   *  the callback can carry the old mailbox's clients across. */
  replacesMailboxId?: string;
}) {
  return (
    <form action={connectMailbox} className="flex flex-col gap-3">
      <input type="hidden" name="organisationId" value={organisationId} />
      {/* Rides the signed OAuth state so the return from Microsoft lands back
          here rather than in the setup flow. */}
      <input type="hidden" name="flow" value="settings" />
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
        <p className="text-xs text-muted-foreground">
          Personal Outlook and Hotmail addresses work too. You&apos;ll sign in at Microsoft — Eva
          never sees your password.
        </p>
      </div>
      <div>
        <button type="submit" className={BUTTON_CLASS}>
          {label}
        </button>
      </div>
    </form>
  );
}
