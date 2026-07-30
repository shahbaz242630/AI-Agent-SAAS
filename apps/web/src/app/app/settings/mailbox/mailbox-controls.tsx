"use client";

import { useActionState, useState } from "react";
import {
  connectMailbox,
  disconnectMailbox,
  sendTestEmail,
  type MailboxActionState,
} from "../actions";

const INITIAL_STATE: MailboxActionState = {};

const BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60";
const SECONDARY_BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-muted px-4 py-2 text-sm font-medium hover:opacity-80 disabled:opacity-60";
const DANGER_BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-danger px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60";

export function MailboxControls({
  organisationId,
  connected,
  reconnectNeeded,
}: {
  organisationId: string;
  connected: boolean;
  /** healthStatus === 'auth_expired' — surface Connect as the fix. */
  reconnectNeeded: boolean;
}) {
  const [disconnectState, disconnectAction, disconnectPending] = useActionState(
    disconnectMailbox,
    INITIAL_STATE,
  );
  const [testEmailState, testEmailAction, testEmailPending] = useActionState(
    sendTestEmail,
    INITIAL_STATE,
  );
  // Two-step confirm rather than window.confirm(): a native modal blocks the
  // page for browser automation (the slice's own e2e drives this button), and
  // an inline step states the consequence where the user is looking.
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      {(!connected || reconnectNeeded) && (
        <form action={connectMailbox}>
          <input type="hidden" name="organisationId" value={organisationId} />
          <button type="submit" className={BUTTON_CLASS}>
            {reconnectNeeded ? "Reconnect Outlook mailbox" : "Connect Outlook mailbox"}
          </button>
        </form>
      )}

      {connected && !reconnectNeeded && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <form action={testEmailAction}>
              <input type="hidden" name="organisationId" value={organisationId} />
              <button type="submit" disabled={testEmailPending} className={BUTTON_CLASS}>
                {testEmailPending ? "Sending…" : "Send test email"}
              </button>
            </form>
            {!confirmingDisconnect && (
              <button
                type="button"
                onClick={() => setConfirmingDisconnect(true)}
                className={SECONDARY_BUTTON_CLASS}
              >
                Disconnect
              </button>
            )}
          </div>

          {confirmingDisconnect && (
            <div className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-background p-4">
              <p className="text-sm">
                Disconnect this mailbox? Eva can&apos;t send any reminders until you reconnect.
              </p>
              <div className="flex flex-wrap gap-3">
                <form action={disconnectAction}>
                  <input type="hidden" name="organisationId" value={organisationId} />
                  <button
                    type="submit"
                    disabled={disconnectPending}
                    className={DANGER_BUTTON_CLASS}
                  >
                    {disconnectPending ? "Disconnecting…" : "Yes, disconnect"}
                  </button>
                </form>
                <button
                  type="button"
                  onClick={() => setConfirmingDisconnect(false)}
                  disabled={disconnectPending}
                  className={SECONDARY_BUTTON_CLASS}
                >
                  Keep it connected
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {[disconnectState, testEmailState].map(
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
