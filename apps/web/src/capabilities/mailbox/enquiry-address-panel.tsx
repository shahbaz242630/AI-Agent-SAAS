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
 */
export function EnquiryAddressPanel({
  address,
  /**
   * ⚠️ OFF BY DEFAULT SO THE GUIDE NEVER LINKS TO ITSELF. This panel is drawn
   * on the enquiry book AND at the top of the forwarding guide; a link that
   * reads "set up forwarding" while you are standing on the forwarding page is
   * the kind of small dishonesty that makes a screen feel broken.
   */
  forwardingHref,
}: {
  address: string;
  forwardingHref?: string;
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
          it. Anything sent here becomes an enquiry below.
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
       * ⚠️ SAYS WHAT EVA DOES NOT DO YET, AND STAYS UNTIL SHE DOES. Enquiries
       * now genuinely arrive here — but nothing is answered until 3.1c. A panel
       * that only said "put this on your website" would let a customer believe
       * their enquiries were being replied to, which is the money-bug family:
       * a screen implying an outcome that does not happen.
       */}
      <p className="text-[12.5px] text-muted-foreground">
        Eva records every enquiry that arrives here, with the proof of who sent it and when. She
        does not reply to them yet — that part is still being built.
      </p>

      {/**
       * ⚠️ NAMES GMAIL, AND ONLY BECAUSE THE LINK GOES SOMEWHERE THAT IS ABOUT
       * GMAIL (ruling 35). The panel itself stays provider-neutral: an Outlook
       * customer reads the sentences above and is never sent into Google's
       * world by accident.
       */}
      {forwardingHref && (
        <p className="text-[12.5px] text-muted-foreground">
          On Gmail?{" "}
          <a href={forwardingHref} className="font-medium text-link hover:underline">
            Set your enquiries to forward here
          </a>{" "}
          — Eva handles Google&apos;s confirmation, so you never need the code.
        </p>
      )}
    </section>
  );
}
