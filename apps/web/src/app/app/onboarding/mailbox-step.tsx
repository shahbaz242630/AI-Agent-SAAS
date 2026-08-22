"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { PrimaryButton } from "@/components/ui";
import { connectMailbox } from "../settings/actions";

/**
 * Step two: pick a provider, say which mailbox, go and approve it there.
 *
 * ⚠️ GMAIL WAS NAMED HERE AND DISABLED FOR MONTHS, AND 3.1b MADE IT REAL. The
 * card was shown greyed out deliberately — a picker offering exactly one thing
 * reads like one that always will — and it is now simply a second option. If
 * this ever goes back to one provider, take the card out rather than re-greying
 * it: an option that has worked and stopped is a fault, not a roadmap.
 *
 * ⚠️ THERE IS NO "BACK" ON THIS STEP, AND THE DESIGN DRAWS ONE. Reaching here
 * means the organisation already exists — the flow reads its position from
 * server state, which is what lets it survive the round trip through Microsoft —
 * and nothing in the API renames an organisation. A back link would offer to
 * undo something that cannot be undone.
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
    detail: "Google Workspace and personal Gmail",
    available: true,
  },
];

/** Nothing leaves this screen without it: the mailbox is the customer's, and
 *  saying so beside the field is worth more than saying so in a paragraph. */
function LockIcon() {
  return (
    <svg
      aria-hidden
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      className="mt-0.5 shrink-0 text-faint"
    >
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function SubmitButton({ destination }: { destination: string }) {
  // Minting the authorize URL is a round trip to our API before the browser
  // leaves, so without this the button looks dead for a moment on the one click
  // that matters most. It names where they are going, because "Taking you to
  // Microsoft…" while they are connecting Gmail is the kind of small wrongness
  // that makes somebody stop and wonder what else is wrong.
  const { pending } = useFormStatus();
  return (
    <PrimaryButton disabled={pending}>
      {pending ? `Taking you to ${destination}…` : "Connect mailbox"}
    </PrimaryButton>
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
    <form action={connectMailbox} className="flex flex-1 flex-col pt-1">
      {/* The pane's subheading and the radio group's accessible name are the
          same sentence, so it is written once and referenced. A `<legend>`
          cannot be used: it would have to live inside the fieldset, and the
          design puts this line above the cards, under the title. */}
      <p id="mailbox-provider" className="text-[13.5px] text-muted-foreground">
        Where do you send email from?
      </p>

      <input type="hidden" name="organisationId" value={organisationId} />
      {/* Rides the signed OAuth state so the return from Microsoft lands back
          in this flow rather than on the settings page. */}
      <input type="hidden" name="flow" value="onboarding" />

      {/* ⚠️ THIS FIELD IS NOW READ BY THE API, WHICH IT WAS NOT BEFORE 3.1b.
          It picks which provider's authorize URL gets built, and the server
          action re-validates it against a closed list — a server action is
          reachable by direct POST, so this is untrusted input however our own
          UI renders it. Anything unrecognised falls back to Microsoft. */}
      <fieldset aria-labelledby="mailbox-provider" className="flex flex-wrap gap-3 pt-[22px]">
        {PROVIDERS.map((option) => {
          const selected = provider === option.id;
          return (
            <label
              key={option.id}
              className={`flex min-w-[220px] flex-1 items-start gap-3 rounded-[var(--radius-card)] px-4.5 py-4 ${
                !option.available
                  ? "border border-border opacity-55"
                  : selected
                    ? "cursor-pointer border-2 border-primary bg-selected-tint"
                    : "cursor-pointer border border-border hover:bg-chip-hover"
              }`}
            >
              <input
                type="radio"
                name="provider"
                value={option.id}
                checked={selected}
                disabled={!option.available}
                onChange={() => setProvider(option.id)}
                className="peer sr-only"
              />
              {/* Drawn rather than native so the disc matches the rest of the
                  design; the real radio is still there, still focusable, and
                  still what a screen reader and the form both read. */}
              <span
                aria-hidden
                className={`mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full border-2 peer-focus-visible:ring-2 peer-focus-visible:ring-accent ${
                  option.available ? "border-primary" : "border-input-border"
                }`}
              >
                {selected && <span className="size-2 rounded-full bg-primary" />}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold">{option.name}</span>
                  {!option.available && (
                    <span className="rounded-[var(--radius-pill)] border border-neutral-border bg-neutral-tint px-2 py-px text-[10.5px] font-bold tracking-[0.04em] text-faint uppercase">
                      Coming soon
                    </span>
                  )}
                </span>
                <span className="text-xs leading-[1.4] text-muted-foreground">{option.detail}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="flex flex-col gap-1.5 pt-[22px]">
        <label htmlFor="emailAddress" className="text-[13px] font-semibold">
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
          className="w-full max-w-[360px] rounded-[var(--radius-control)] border border-input-border bg-surface px-3.5 py-2.5 text-sm outline-none focus:border-primary"
        />
      </div>

      {/* Saying where the password goes is not reassurance copy. A product
          that asks for an email address and then a password in its own UI is
          training people into precisely the behaviour phishing relies on. */}
      <div className="mt-[22px] flex items-start gap-2.5 rounded-xl bg-muted px-4 py-3">
        <LockIcon />
        {/* ⚠️ THE BUTTON BELOW HAS NAMED THE RIGHT PROVIDER SINCE #107 AND
            THIS PARAGRAPH DID NOT, SO SOMEBODY CONNECTING GMAIL WAS TOLD THEY
            WOULD SIGN IN AT MICROSOFT — two inches apart, contradicting each
            other. Found by the standing grep after the send-permission fix, in
            the same file the provider picker was added to. A conditional that
            covers one string in a component and not its neighbour is the
            easiest kind of stale copy to write and the hardest to see. */}
        <p className="text-[12.5px] leading-[1.5] text-muted-foreground">
          {provider === "google" ? (
            <>
              You&apos;ll sign in at Google — Eva never sees your password. Personal Gmail and
              Google Workspace addresses both work.
            </>
          ) : (
            <>
              You&apos;ll sign in at Microsoft — Eva never sees your password. Personal Outlook and
              Hotmail addresses work too.
            </>
          )}
        </p>
      </div>

      <div className="min-h-8 flex-1" />

      {/*
       * ⚠️ THE WAY OUT, ADDED 2026-08-11 AFTER THE FOUNDER GOT STUCK HERE.
       * Until now this step offered "Connect mailbox" or nothing: no skip, no
       * link onward, and the sidebar is hidden during setup. A customer who
       * could not finish — most obviously one whose IT administrator has to
       * approve the connection, which this very page has a helper for — had a
       * wall. They could not add an invoice, import a spreadsheet, or look at
       * the product they had just signed up for. The only other control on the
       * screen was "Sign out".
       *
       * ⚠️ AND THE DESTINATION WAS ALREADY BUILT FOR THEM. Home renders a
       * "No mailbox is connected" card whenever the answer is a definite false
       * — `attentionItems` in `products/invoice-follow-up/dashboard.ts` — explaining that nothing will
       * send until one is connected, with a link back. So skipping is not a
       * hole in the flow; the flow just had no door to the room that was
       * waiting. That card is why this link does not need to repeat the
       * consequence here.
       *
       * ⚠️ THIS IS NOT A "BACK", which the header above explains has no meaning
       * on this step. It goes forward, into the product.
       */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/app"
          className="text-[13px] font-semibold text-muted-foreground underline hover:text-foreground"
        >
          I&apos;ll do this later
        </Link>
        <SubmitButton destination={provider === "google" ? "Google" : "Microsoft"} />
      </div>
    </form>
  );
}
