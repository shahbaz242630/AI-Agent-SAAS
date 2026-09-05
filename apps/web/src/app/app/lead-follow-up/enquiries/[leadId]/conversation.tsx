"use client";

import { useState, useTransition } from "react";
import { GhostButton } from "@/components/ui";
import {
  timelineEmptyLine,
  timelineEntry,
  type TimelinePage,
} from "@/products/lead-follow-up/lead-book";

/**
 * Everything exchanged with the person, newest first, a page at a time
 * (slice 3.3c; paged since ruling 81, 2026-09-05).
 *
 * ⚠️ NEWEST FIRST NOW. 3.3c read the conversation oldest first, "because a
 * conversation is read top-down". At three hundred enquiries the latest
 * message is what somebody opens the page for, and the rest is one "Show
 * earlier" away. The person's own messages are still set apart on the page's
 * background so a glance tells who said what.
 *
 * ⚠️ THE LOADER ARRIVES AS A PROP (a server action), so this stays
 * renderable in a plain node test.
 */
export type LoadConversationResult =
  { ok: true; page: TimelinePage } | { ok: false; error: string };

export function Conversation({
  organisationId,
  leadId,
  who,
  timezone,
  initial,
  unavailable,
  loadEarlier,
}: {
  organisationId: string;
  leadId: string;
  who: string;
  timezone: string;
  initial: TimelinePage;
  unavailable: boolean;
  loadEarlier: (
    organisationId: string,
    leadId: string,
    before: string,
    beforeId: string,
  ) => Promise<LoadConversationResult>;
}) {
  const [items, setItems] = useState(initial.items);
  const [hasEarlier, setHasEarlier] = useState(initial.hasEarlier);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function showEarlier() {
    const last = items.at(-1);
    if (!last) return;
    startTransition(async () => {
      const result = await loadEarlier(organisationId, leadId, last.happenedAt, last.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setItems((current) => [...current, ...result.page.items]);
      setHasEarlier(result.page.hasEarlier);
      setError(null);
    });
  }

  return (
    <section className="flex w-full flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-5">
      <h2 className="text-sm font-semibold">Everything exchanged with {who}</h2>
      <p className="text-xs text-muted-foreground">
        Every message to or from this person on any channel, newest first — including earlier
        enquiries from the same person, and Eva&apos;s replies.
      </p>
      {unavailable ? (
        <p className="text-sm text-muted-foreground">
          The conversation could not be loaded just now. The enquiry above is unaffected.
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{timelineEmptyLine(who)}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {items.map((item) => {
            const entry = timelineEntry(item, who, timezone);
            return (
              <li
                key={item.id}
                className={`flex flex-col gap-1 rounded-[var(--radius-card)] px-4 py-3 ${
                  entry.fromThem ? "bg-background" : "border border-border"
                }`}
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-semibold">{entry.who}</span>
                  <span className="text-[11.5px] tracking-[0.04em] text-faint">{entry.meta}</span>
                </div>
                {entry.subject && <span className="text-sm font-medium">{entry.subject}</span>}
                {/* Their words, as written — the same rule as the enquiry above. */}
                <p className="text-sm whitespace-pre-wrap">{entry.body}</p>
              </li>
            );
          })}
        </ol>
      )}
      {hasEarlier && (
        <div className="flex flex-wrap items-center gap-3">
          <GhostButton onClick={showEarlier}>{pending ? "Loading…" : "Show earlier"}</GhostButton>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      )}
    </section>
  );
}
