"use client";

import { useState } from "react";
import { PrimaryAction } from "@/components/ui";

/**
 * The address a customer puts on their website (Slice 3.1b, ruling 29).
 *
 * ⚠️ THIS IS THE ONE THING ON THE SCREEN THAT HAS TO BE COPIED EXACTLY. A
 * mistyped character is not a validation error — it is a website quietly
 * sending every enquiry to an address nobody owns, with nothing failing
 * anywhere to say so. So: monospace, selectable, and a copy button, rather than
 * a sentence with an address embedded in it that somebody will re-type.
 *
 * ⚠️ CLIENT COMPONENT ONLY BECAUSE OF THE COPY BUTTON. The address itself is
 * rendered by the server and passed in; nothing here fetches anything.
 *
 * ⚠️ IT LIVES ON THE MAILBOX TAB NOW, NOT THE ENQUIRY BOOK (founder,
 * 2026-09-05). From 3.1b it sat on top of the book because the book was the
 * only screen a customer had; it is a set-up step, and set-up has a home. The
 * forwarding steps are drawn directly under it there, so the panel no longer
 * carries a link to them.
 */
export function EnquiryAddressPanel({
  address,
  /**
   * Where "what Eva replies" goes. Optional so the panel reads correctly with
   * or without the link.
   */
  repliesHref,
}: {
  address: string;
  repliesHref?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /**
       * ⚠️ SILENT ON PURPOSE, AND THE ADDRESS IS STILL SELECTABLE. The
       * clipboard API is refused outright in some browsers and over plain
       * HTTP. An error message here would be alarming and useless — the
       * address is right there to select by hand, which is what somebody does
       * anyway when a copy button does not respond.
       */
      setCopied(false);
    }
  }

  return (
    <section className="flex w-full flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-[13.5px] font-semibold">Your enquiry address</h2>
        <p className="text-sm text-muted-foreground">
          Put this on your website and on your enquiry forms, or forward your existing enquiries to
          it. Anything sent here becomes an enquiry.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <code className="flex-1 rounded-[var(--radius-card)] border border-hairline bg-muted px-3.5 py-2.5 font-mono text-[13.5px] break-all select-all">
          {address}
        </code>
        {/* ⚠️ WAS A HAND-ROLLED PRIMARY — the SEVENTH copy of the wrong shape,
            and the one nothing was looking at. It carried the CARD radius,
            `text-sm`, `font-medium` and no shadow or hover, exactly like the
            five #126 fixed and the sixth #127 found. It survived because the
            scan that catches this shape only read the settings folder, and this
            file was never in it; slice 3.1c-0 widened the scan to
            `capabilities/mailbox` and it went red immediately. `PrimaryAction`
            is the kit's button for an onClick that must stay type="button". */}
        <PrimaryAction onClick={copy}>{copied ? "Copied" : "Copy"}</PrimaryAction>
      </div>

      {/**
       * ⚠️ THIS SENTENCE WENT STALE ON PRODUCTION AND NOTHING CAUGHT IT. From
       * 3.1b it told the customer that Eva did not answer enquiries yet and
       * that the answering was unbuilt, under a comment promising the sentence
       * would stay until she did. She did — 3.1c-3 shipped the automatic reply
       * on 2026-09-01 — and the sentence stayed, telling every customer for
       * four days that Eva could not do the thing she was doing. The founder
       * read it on 2026-09-05. `enquiry-address-panel.spec.tsx` now asserts
       * the CLAIM, not the words: this file may not say Eva stays silent —
       * not even in a comment quoting the old line, which is how the first
       * run of that spec went red.
       *
       * "The wording you have marked as automatic" is conditional by
       * construction — a customer who has switched the automatic reply off has
       * marked none, and the Replies screen says so in red.
       */}
      <p className="text-[12.5px] text-muted-foreground">
        Eva records every enquiry that arrives here, with the proof of who sent it and when, and
        answers it with the wording you have marked as automatic
        {repliesHref ? (
          <>
            {" — "}
            <a href={repliesHref} className="font-medium text-link hover:underline">
              what Eva replies
            </a>
          </>
        ) : null}
        .
      </p>
    </section>
  );
}
