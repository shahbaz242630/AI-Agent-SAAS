"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { connectMailbox } from "../settings/actions";

/**
 * Step two: pick a provider, say which mailbox, go to Microsoft.
 *
 * Gmail is named and visibly disabled rather than omitted. Eva is not a
 * Microsoft-only product and a picker that offers exactly one thing reads like
 * one that always will — showing the second option sets the expectation without
 * shipping a line of Gmail code.
 */

interface Provider {
  id: string;
  name: string;
  detail: string;
  available: boolean;
}

const PROVIDERS: Provider[] = [
  {
    id: "microsoft",
    name: "Outlook",
    detail: "Outlook.com, Hotmail, or a work Microsoft 365 account",
    available: true,
  },
  {
    id: "google",
    name: "Gmail",
    detail: "Coming soon",
    available: false,
  },
];

function SubmitButton() {
  // Minting the authorize URL is a round trip to our API before the browser
  // leaves for Microsoft, so without this the button looks dead for a moment on
  // the one click that matters most.
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
    >
      {pending ? "Taking you to Microsoft…" : "Connect mailbox"}
    </button>
  );
}

export function MailboxStep({
  organisationId,
  defaultAddress,
}: {
  organisationId: string;
  /** Pre-fills the address after a failed attempt, so a customer who has just
   *  been sent to ask their administrator does not retype it. */
  defaultAddress?: string | null;
}) {
  const [provider, setProvider] = useState("microsoft");

  return (
    <form action={connectMailbox} className="flex w-full flex-col gap-5">
      <input type="hidden" name="organisationId" value={organisationId} />
      {/* Rides the signed OAuth state so the return from Microsoft lands back
          in this flow rather than on the settings page. */}
      <input type="hidden" name="flow" value="onboarding" />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Where do you send email from?</legend>
        <div className="mt-1 flex flex-col gap-2">
          {PROVIDERS.map((option) => (
            <label
              key={option.id}
              className={`flex items-start gap-3 rounded-[var(--radius-card)] border px-4 py-3 ${
                !option.available
                  ? "border-muted-foreground/15 opacity-60"
                  : provider === option.id
                    ? "cursor-pointer border-primary"
                    : "cursor-pointer border-muted-foreground/30"
              }`}
            >
              <input
                type="radio"
                name="provider"
                value={option.id}
                checked={provider === option.id}
                disabled={!option.available}
                onChange={() => setProvider(option.id)}
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{option.name}</span>
                <span className="text-xs text-muted-foreground">{option.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1">
        <label htmlFor="emailAddress" className="text-sm font-medium">
          Which address do you send from?
        </label>
        <input
          id="emailAddress"
          name="emailAddress"
          type="email"
          required
          autoComplete="email"
          defaultValue={defaultAddress ?? ""}
          placeholder="you@yourcompany.co.uk"
          className="mt-1 w-full max-w-sm rounded-[var(--radius-card)] border border-muted-foreground/30 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
        {/* Saying where the password goes is not reassurance copy. A product
            that asks for an email address and then a password in its own UI is
            training people into precisely the behaviour phishing relies on. */}
        <p className="text-xs text-muted-foreground">
          You&apos;ll sign in at Microsoft — Eva never sees your password. Personal Outlook and
          Hotmail addresses work too.
        </p>
      </div>

      <div>
        <SubmitButton />
      </div>
    </form>
  );
}
