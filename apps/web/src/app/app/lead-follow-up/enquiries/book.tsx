"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { LEAD_BOOK_PAGE_SIZE, moduleHref } from "@eva/types";
import {
  EmptyState,
  GhostLink,
  Pagination,
  StatusPill,
  Table,
  TableCell,
  TableRow,
} from "@/components/ui";
import { pageCountFor } from "@/lib/pagination";
import { describeMoment } from "@/lib/today";
import {
  answeredLabel,
  bookExportQueryString,
  bookFilterLine,
  bookHref,
  contactLine,
  leadChannelLabel,
  leadName,
  leadStatusLabel,
  leadStatusTone,
  type LeadBook,
  type LeadBookFilters,
  type LeadBookRow,
} from "@/products/lead-follow-up/lead-book";

/**
 * The enquiry book at volume (ruling 81; the founder, 2026-09-05: *"need to
 * look clean at 200-300 plus inquiries"*).
 *
 * ⚠️ THE PAGE SWAPS IN PLACE. The founder's other sentence was *"instead of
 * whole page going to next page when user selects 1,2,3 or forward arrow it
 * just moves to next on same window"*. So a tab, a chip, a search or a page
 * number asks the server action for the new page and replaces the rows,
 * then pushes the address into the browser's history — which Next's router
 * picks up, so the URL is always a link somebody can keep and Back returns
 * to the previous page of results.
 *
 * ⚠️ THE FILTERS ARE STILL LINKS. Each tab and chip carries the address it
 * would go to, and only intercepts a plain left click. Middle-click, a new
 * tab, and a browser without JavaScript all still work, and the invoice book
 * keeps the same bookmarkable shape.
 *
 * ⚠️ THE LOADER ARRIVES AS A PROP. It is a server action; taking it from the
 * page rather than importing it keeps this component renderable in a plain
 * node test, where `next/cache` is not.
 */

const BOOK = moduleHref("lead_follow_up", "enquiries");
const EXPORT = moduleHref("lead_follow_up", "enquiries/export");
const MAILBOX = moduleHref("lead_follow_up", "mailbox");

const COLUMNS = [
  // The row's number in the whole book, not on the page: page 3 starts at
  // 21, so "the fourteenth one" means the same thing on every page.
  { label: "#", align: "right" },
  { label: "Who" },
  { label: "How to reach them" },
  { label: "What they asked" },
  { label: "Channel" },
  { label: "Received" },
  { label: "Answered" },
  { label: "Stage" },
] as const;

export type LoadBookResult = { ok: true; book: LeadBook } | { ok: false; error: string };

export function EnquiryBook({
  organisationId,
  timezone,
  initial,
  load,
}: {
  organisationId: string;
  timezone: string;
  initial: { book: LeadBook; filters: LeadBookFilters; page: number };
  load: (organisationId: string, filters: LeadBookFilters, page: number) => Promise<LoadBookResult>;
}) {
  const [book, setBook] = useState(initial.book);
  const [filters, setFilters] = useState(initial.filters);
  const [page, setPage] = useState(initial.page);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const top = useRef<HTMLDivElement>(null);

  const pageCount = pageCountFor(book.totalCount, LEAD_BOOK_PAGE_SIZE);
  const stageName = filters.stage
    ? (book.stages.find((stage) => stage.key === filters.stage)?.name ?? null)
    : null;
  const filtered = Boolean(filters.stage || filters.channel || filters.answered || filters.search);

  function go(nextFilters: LeadBookFilters, nextPage: number) {
    startTransition(async () => {
      const result = await load(organisationId, nextFilters, nextPage);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBook(result.book);
      setFilters(nextFilters);
      setPage(nextPage);
      setError(null);
      window.history.pushState(null, "", bookHref(BOOK, nextFilters, nextPage));
    });
  }

  /**
   * Turning a page scrolls the table back to its top — in the click handler,
   * before the load, so the ref is never read during render (the lint rule
   * that caught it reading inside `go` was right).
   */
  function turnTo(nextPage: number) {
    if (top.current) {
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      top.current.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
    }
    go(filters, nextPage);
  }

  /** A filter link: a real address, and an in-place swap on a plain click. */
  function filterLink(label: string, nextFilters: LeadBookFilters, selected: boolean, key: string) {
    return (
      <a
        key={key}
        href={bookHref(BOOK, nextFilters, 1)}
        {...(selected ? { "aria-current": "true" as const } : {})}
        onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          go(nextFilters, 1);
        }}
        className={`rounded-[var(--radius-pill)] px-3 py-1.5 text-xs font-semibold ${
          selected
            ? "bg-primary text-primary-foreground"
            : "border border-input-border bg-surface hover:bg-chip-hover"
        }`}
      >
        {label}
      </a>
    );
  }

  const stageTabs = book.stages.filter((stage) => stage.count > 0 || stage.key === filters.stage);

  return (
    <div ref={top} className="flex w-full scroll-mt-6 flex-col gap-4">
      {/* Stage tabs, with counts, only for stages that hold something. Every
          enquiry is "New" until the engine slice moves stages, so today this
          row is short; the shape is right for when it is not.
          "All" is the whole book and clears EVERYTHING — chips and the search
          too (founder, 2026-09-05: "all tabs clears every filter"; it had
          read "44" with a channel on). So its number is the book's, not the
          filter's, and it is the selected tab only when nothing at all is on. */}
      <div className="flex flex-wrap items-center gap-2">
        {filterLink(`All ${book.bookCount}`, {}, !filtered, "all")}
        {stageTabs.map((stage) =>
          filterLink(
            `${stage.name} ${stage.count}`,
            { ...filters, stage: stage.key ?? undefined },
            filters.stage === stage.key,
            stage.id,
          ),
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {filterLink(
            "Email",
            { ...filters, channel: filters.channel === "email" ? undefined : "email" },
            filters.channel === "email",
            "email",
          )}
          {filterLink(
            "WhatsApp",
            { ...filters, channel: filters.channel === "whatsapp" ? undefined : "whatsapp" },
            filters.channel === "whatsapp",
            "whatsapp",
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {filterLink(
            "Unanswered",
            { ...filters, answered: filters.answered === "no" ? undefined : "no" },
            filters.answered === "no",
            "unanswered",
          )}
          {filterLink(
            "Answered",
            { ...filters, answered: filters.answered === "yes" ? undefined : "yes" },
            filters.answered === "yes",
            "answered",
          )}
        </div>
        {/* A plain GET form, so a search is an address; JavaScript swaps in place. */}
        <form
          action={BOOK}
          method="get"
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get("search");
            const search = typeof value === "string" ? value.trim() : "";
            go({ ...filters, search: search === "" ? undefined : search }, 1);
          }}
        >
          {filters.stage && <input type="hidden" name="stage" value={filters.stage} />}
          {filters.channel && <input type="hidden" name="channel" value={filters.channel} />}
          {filters.answered && <input type="hidden" name="answered" value={filters.answered} />}
          <input
            type="search"
            name="search"
            defaultValue={filters.search ?? ""}
            placeholder="Name, phone, email or a word they used"
            aria-label="Search enquiries"
            className="w-64 max-w-full rounded-[var(--radius-control)] border border-input-border bg-surface px-3 py-1.5 text-xs"
          />
          <button
            type="submit"
            className="rounded-[var(--radius-control)] border border-input-border bg-surface px-3 py-1.5 text-xs font-semibold hover:bg-chip-hover"
          >
            Search
          </button>
        </form>
        {/* The search stays on while chips change, which is right — and it
            has to be visible as a thing that is ON, or a chip that finds
            nothing looks like a channel with nothing in it (the founder,
            2026-09-05: "when I select whatsapp nothing is there"). */}
        {filters.search &&
          filterLink(
            `“${filters.search}” ×`,
            { ...filters, search: undefined },
            true,
            "clear-search",
          )}
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {bookFilterLine({
            totalCount: book.totalCount,
            showing: book.rows.length,
            page,
            pageSize: LEAD_BOOK_PAGE_SIZE,
            filters,
            stageName,
          })}
          {pending && " Loading…"}
        </p>
        {/* One way back to the whole book, whatever is on. The address bar
            carries the filters — that is what makes them bookmarkable — so a
            refresh keeps them, and this is how somebody puts them down. */}
        {filtered && (
          <a
            href={BOOK}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              go({}, 1);
            }}
            className="text-sm font-medium text-link hover:underline"
          >
            Clear all filters
          </a>
        )}
        {/* Every row the filter selects, not only the page — the All tab is
            one click away for somebody who wants the lot. The address goes
            through the app so the api sees the session; the `download`
            attribute tells the browser this is a file, not a page. */}
        {book.totalCount > 0 && (
          <a
            href={`${EXPORT}?${bookExportQueryString(filters)}`}
            download
            className="text-sm font-medium text-link hover:underline"
          >
            Download CSV
          </a>
        )}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {book.rows.length === 0 ? (
        filtered ? (
          <EmptyState headline="Nothing matches." detail="Try fewer filters, or a different word.">
            <GhostLink href={BOOK}>Clear the filters</GhostLink>
          </EmptyState>
        ) : (
          <EmptyState
            headline="No enquiries yet."
            detail="Set up where enquiries come in on the Mailbox tab, and each one appears here with the proof of who sent it and when."
          >
            <GhostLink href={MAILBOX}>Set up where enquiries come in</GhostLink>
          </EmptyState>
        )
      ) : (
        <div className={pending ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <Table minWidth={1100} columns={COLUMNS}>
            {book.rows.map((lead, index) => (
              <BookRow
                key={lead.id}
                number={(page - 1) * LEAD_BOOK_PAGE_SIZE + index + 1}
                lead={lead}
                timezone={timezone}
              />
            ))}
          </Table>
        </div>
      )}

      <Pagination page={page} pageCount={pageCount} busy={pending} onSelect={turnTo} />
    </div>
  );
}

function BookRow({
  number,
  lead,
  timezone,
}: {
  number: number;
  lead: LeadBookRow;
  timezone: string;
}) {
  const stopped = lead.status === "do_not_contact";
  return (
    <TableRow hover alignTop>
      <TableCell align="right" className="text-faint tabular-nums">
        {number}
      </TableCell>
      <TableCell>
        <Link href={`${BOOK}/${lead.id}`} className="font-medium text-link hover:underline">
          {leadName(lead)}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">{contactLine(lead)}</TableCell>
      {/* Two lines, then cut — never summarised: the whole thing is on the
          detail screen, and inventing a shorter version of what somebody
          actually said is how a quote stops being one. The width lives on
          an inner block because a table cell ignores max-width, which is
          how a long message pushed the other columns out of the box
          (the founder, 2026-09-05). */}
      <TableCell className="text-muted-foreground">
        <span className="line-clamp-2 block max-w-[420px] whitespace-normal">
          {lead.enquiry ?? "—"}
        </span>
      </TableCell>
      <TableCell>{leadChannelLabel(lead.source)}</TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {describeMoment(lead.receivedAt, timezone)}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {answeredLabel(lead.receivedAt, lead.firstRespondedAt, timezone)}
      </TableCell>
      <TableCell>
        {/* A do-not-contact outranks the stage: it is the one thing on the
            row somebody must not miss. */}
        {stopped ? (
          <StatusPill tone={leadStatusTone(lead.status)}>{leadStatusLabel(lead.status)}</StatusPill>
        ) : (
          <StatusPill tone="mute">{lead.stage.name}</StatusPill>
        )}
      </TableCell>
    </TableRow>
  );
}
