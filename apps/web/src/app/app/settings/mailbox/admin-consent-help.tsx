"use client";

import { useState } from "react";

/**
 * The screen a customer reaches when Microsoft declines the connection.
 *
 * It deliberately offers BOTH readings of what happened. Microsoft reports
 * "your administrator must approve this" and "you pressed cancel" with the
 * identical `access_denied` (defect F1, proven on live staging 2026-07-30), so
 * any wording that picks one is wrong half the time — and picking "you
 * cancelled", which is what shipped, strands every customer who is not their
 * own Microsoft administrator.
 *
 * For a personal Microsoft account the administrator half is dropped entirely:
 * there is no administrator, and sending a sole trader to find an IT department
 * is worse than saying nothing.
 */

interface Props {
  accountKind: "work" | "personal" | "unknown";
  url: string | null;
  organisationName: string | null;
  attemptedAddress: string | null;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="rounded-[var(--radius-card)] bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function AdminConsentHelp({ accountKind, url, organisationName, attemptedAddress }: Props) {
  const who = organisationName
    ? `whoever manages Microsoft 365 at ${organisationName}`
    : "whoever manages Microsoft 365 where you work";

  const email = url
    ? [
        "Hi,",
        "",
        "I'm setting up Eva to chase our unpaid invoices automatically. It sends the",
        "reminders from our own Microsoft 365 mailbox, so it needs to be approved by",
        "whoever administers our Microsoft 365 account.",
        "",
        "Could you open this link and approve it?",
        "",
        url,
        "",
        "It asks for permission to read and send mail from my mailbox. Nothing is sent",
        "until I finish setting it up.",
        "",
        "Thanks",
      ].join("\n")
    : "";

  return (
    <section className="flex w-full max-w-2xl flex-col gap-4 rounded-[var(--radius-card)] border border-muted-foreground/20 px-6 py-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">We couldn&apos;t connect that mailbox</h2>
        <p className="text-sm text-muted-foreground">
          {attemptedAddress ? (
            <>
              Microsoft didn&apos;t complete the connection for{" "}
              <span className="font-medium">{attemptedAddress}</span>.{" "}
            </>
          ) : (
            <>Microsoft didn&apos;t complete the connection. </>
          )}
          {accountKind === "personal"
            ? "Either it was cancelled, or the wrong account was chosen."
            : "Either it was cancelled, or Eva needs to be approved by your Microsoft 365 administrator first — Microsoft doesn't tell us which."}
        </p>
      </div>

      {accountKind === "personal" ? (
        <p className="text-sm text-muted-foreground">
          This is a personal Microsoft account, so there&apos;s no administrator to ask — just try
          again and accept the permissions.
        </p>
      ) : url ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            If you&apos;re not the administrator, send this link to {who}. Approving it takes them
            about a minute, and once done you can connect straight away.
          </p>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={url}
                aria-label="Administrator approval link"
                onFocus={(event) => event.currentTarget.select()}
                className="min-w-0 flex-1 rounded-[var(--radius-card)] border border-muted-foreground/30 bg-background px-3 py-2 text-xs"
              />
              <CopyButton value={url} label="Copy link" />
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer text-primary">
                Or copy a ready-written email to forward
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                <textarea
                  readOnly
                  rows={12}
                  value={email}
                  aria-label="Email to forward to your administrator"
                  className="w-full rounded-[var(--radius-card)] border border-muted-foreground/30 bg-background px-3 py-2 font-mono text-xs"
                />
                <div>
                  <CopyButton value={email} label="Copy email" />
                </div>
              </div>
            </details>
          </div>
          <p className="text-sm text-muted-foreground">
            If you <em>are</em> the administrator, just try again and tick &ldquo;Consent on behalf
            of your organisation&rdquo;.
          </p>
        </div>
      ) : null}
    </section>
  );
}
