import { describe, expect, it } from "vitest";
import {
  attentionItems,
  chaseSummary,
  overdueLine,
  owedHeadline,
  owedRows,
  type CurrencyTotal,
} from "@/lib/dashboard";

/**
 * The home screen's logic (Slice 1.9).
 *
 * The one that matters is the cross-currency guard. A dashboard is the most
 * tempting possible place to show a single "you are owed" figure, and doing so
 * is a confident lie for any business trading in more than one currency —
 * exactly the defect that shipped once through the book's currency picker.
 */

const GBP: CurrencyTotal = { currency: "GBP", invoiceCount: 9, outstandingMinorUnits: 150_000 };
/** 4,750.499 KWD = 4,750,499 fils — a far BIGGER integer than the sterling book. */
const KWD: CurrencyTotal = { currency: "KWD", invoiceCount: 3, outstandingMinorUnits: 4_750_499 };
const AED: CurrencyTotal = { currency: "AED", invoiceCount: 3, outstandingMinorUnits: 900_000 };

describe("dashboard", () => {
  describe("what you are owed", () => {
    /**
     * ⚠️ THE WHOLE POINT OF THIS FILE. Minor units are not comparable across
     * currencies: sorting by "biggest number" puts three Kuwaiti invoices above
     * a book that is mostly sterling, because fils are 1/1000 and pence 1/100.
     * A COUNT has no units, so it is the only honest comparison.
     */
    it("orders by invoice count, never by amount", () => {
      const rows = owedRows([KWD, GBP]);
      expect(rows.map((r) => r.currency)).toEqual(["GBP", "KWD"]);
      // Sanity: the losing row really does carry the bigger integer.
      expect(KWD.outstandingMinorUnits).toBeGreaterThan(GBP.outstandingMinorUnits);
    });

    it("breaks a tie alphabetically so the screen does not reshuffle", () => {
      expect(owedRows([KWD, AED]).map((r) => r.currency)).toEqual(["AED", "KWD"]);
      expect(owedRows([AED, KWD]).map((r) => r.currency)).toEqual(["AED", "KWD"]);
    });

    it("drops currencies with nothing outstanding", () => {
      const empty: CurrencyTotal = { currency: "USD", invoiceCount: 0, outstandingMinorUnits: 0 };
      expect(owedRows([GBP, empty]).map((r) => r.currency)).toEqual(["GBP"]);
    });

    it("never merges currencies into one row", () => {
      const rows = owedRows([GBP, KWD, AED]);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.currency)).size).toBe(3);
    });
  });

  describe("how much of each currency is overdue", () => {
    /**
     * ⚠️ MATCHED BY CURRENCY CODE, NEVER BY POSITION — and the fixture is built
     * to catch a positional join. The two lists come from two API calls with
     * different filters, so the overdue one is SHORTER whenever a currency has
     * nothing late: here sterling sorts first and has nothing overdue, while
     * the only overdue row is Kuwaiti. Zipping by index would print 1,250.499
     * dinars of late money under the GBP heading — the cross-currency lie this
     * module exists to prevent, arriving by an array index instead of a sum.
     */
    it("puts each currency's overdue money on its own row", () => {
      const rows = owedRows(
        [GBP, KWD],
        [{ ...KWD, invoiceCount: 2, outstandingMinorUnits: 1_250_499 }],
      );
      const gbp = rows.find((r) => r.currency === "GBP")!;
      const kwd = rows.find((r) => r.currency === "KWD")!;
      expect(gbp.overdueMinorUnits).toBe(0);
      expect(gbp.overdueCount).toBe(0);
      expect(kwd.overdueMinorUnits).toBe(1_250_499);
      expect(kwd.overdueCount).toBe(2);
    });

    it("treats a missing overdue list as nothing being late", () => {
      const rows = owedRows([GBP, KWD]);
      expect(rows.every((r) => r.overdueMinorUnits === 0 && r.overdueCount === 0)).toBe(true);
    });

    /**
     * A currency that is entirely overdue is a real state, and the two figures
     * being equal must not make either of them disappear.
     */
    it("keeps the overdue figure when all of a currency is late", () => {
      const rows = owedRows([GBP], [GBP]);
      expect(rows[0]!.outstandingMinorUnits).toBe(150_000);
      expect(rows[0]!.overdueMinorUnits).toBe(150_000);
    });

    it("says nothing when nothing is late, rather than a zero", () => {
      expect(overdueLine({ formattedOverdue: "£0.00", invoiceCount: 0 })).toBeNull();
    });

    it("counts late invoices in words, singular and plural", () => {
      expect(overdueLine({ formattedOverdue: "£500.00", invoiceCount: 1 })).toBe(
        "£500.00 overdue across 1 invoice",
      );
      expect(overdueLine({ formattedOverdue: "£500.00", invoiceCount: 4 })).toBe(
        "£500.00 overdue across 4 invoices",
      );
    });
  });

  describe("the headline above the figures", () => {
    /**
     * A customer whose clients all pay on time is in the healthiest state there
     * is. A blank panel would read as a failure to load.
     */
    it("treats an empty book as good news, not an error", () => {
      const line = owedHeadline([]);
      expect(line).toContain("Nothing outstanding");
      expect(line.toLowerCase()).not.toContain("error");
    });

    it("uses the singular for one invoice", () => {
      expect(owedHeadline([{ ...GBP, invoiceCount: 1 }])).toBe("1 invoice is outstanding.");
    });

    /**
     * Naming the number of CURRENCIES is what stops a reader mentally adding the
     * cards below together.
     */
    it("says how many currencies there are when there is more than one", () => {
      const line = owedHeadline(owedRows([GBP, KWD]));
      expect(line).toContain("2 currencies");
      expect(line).toContain("12 invoices");
    });
  });

  describe("what needs a human", () => {
    const quiet = { sentLast7Days: 0, waiting: 0, failedLast7Days: 0, scheduled: 0 };

    it("says nothing at all when there is nothing to do", () => {
      expect(
        attentionItems({ mailboxConnected: true, counts: quiet, waitingReason: null }),
      ).toEqual([]);
    });

    /**
     * ⚠️ ORDER IS THE MESSAGE. A disconnected mailbox is upstream of everything
     * else, so listing waiting reminders above it sends someone to investigate a
     * symptom instead of the cause.
     */
    /**
     * ⚠️ RED MEANS STOPPED; AMBER MEANS PENDING. Getting this wrong in the
     * generous direction is the worse failure: a red card that turns out to
     * mean "waiting, all fine" teaches a customer to ignore red, and then the
     * one that means "Eva has stopped sending" is ignored too.
     */
    it("colours a stopped thing red and a pending thing amber", () => {
      const items = attentionItems({
        mailboxConnected: false,
        counts: { sentLast7Days: 0, waiting: 4, failedLast7Days: 2, scheduled: 0 },
        waitingReason: "unknown",
      });
      const tone = (kind: string) => items.find((i) => i.kind === kind)?.tone;
      // Neither of these retries without a human.
      expect(tone("no_mailbox")).toBe("bad");
      expect(tone("reminders_failed")).toBe("bad");
      // This one retries itself on the next run.
      expect(tone("reminders_waiting")).toBe("warn");
    });

    it("puts a disconnected mailbox above everything else", () => {
      const items = attentionItems({
        mailboxConnected: false,
        counts: { sentLast7Days: 0, waiting: 4, failedLast7Days: 2, scheduled: 0 },
        waitingReason: "unknown",
      });
      expect(items[0]?.kind).toBe("no_mailbox");
      expect(items[0]?.href).toBe("/app/settings/mailbox");
    });

    /**
     * The same fact told twice makes the second telling look like a different
     * problem.
     */
    it("does not repeat the mailbox as a separate 'waiting' item", () => {
      const items = attentionItems({
        mailboxConnected: false,
        counts: { sentLast7Days: 0, waiting: 4, failedLast7Days: 0, scheduled: 0 },
        waitingReason: "no_working_mailbox",
      });
      expect(items.map((i) => i.kind)).toEqual(["no_mailbox"]);
    });

    /**
     * `null` is "we could not tell" — no permission, or no Invoice Chasing. Fail
     * quiet rather than sending someone to fix a mailbox that may be fine.
     */
    it("never nags when it could not tell whether a mailbox exists", () => {
      const items = attentionItems({
        mailboxConnected: null,
        counts: quiet,
        waitingReason: null,
      });
      expect(items.some((i) => i.kind === "no_mailbox")).toBe(false);
    });

    it("reports failures and waiting reminders with a way to look at them", () => {
      const items = attentionItems({
        mailboxConnected: true,
        counts: { sentLast7Days: 3, waiting: 1, failedLast7Days: 1, scheduled: 0 },
        waitingReason: "unknown",
      });
      expect(items.map((i) => i.kind)).toEqual(["reminders_failed", "reminders_waiting"]);
      expect(items.every((i) => i.href !== null && i.linkLabel !== null)).toBe(true);
      // Singular, because "1 reminders" is how a reader learns nobody checked.
      expect(items[0]?.headline).toBe("1 reminder didn't send");
      expect(items[1]?.headline).toBe("1 reminder is waiting");
    });
  });

  describe("Eva's week", () => {
    /** Dates arrive pre-resolved in the org's timezone; the panel only formats. */
    const asGiven = (isoDate: string) => isoDate;

    const week = (
      counts: {
        sentLast7Days: number;
        waiting: number;
        failedLast7Days: number;
        scheduled: number;
      },
      upcoming: { scheduledDate: string }[] = [],
    ) =>
      chaseSummary(
        { counts, upcoming: upcoming as Parameters<typeof chaseSummary>[0]["upcoming"] },
        asGiven,
      );

    it("says a quiet week is a quiet week, not a problem", () => {
      const line = week({ sentLast7Days: 0, waiting: 0, failedLast7Days: 0, scheduled: 0 });
      expect(line).toContain("hasn't needed to chase");
    });

    it("counts what was sent", () => {
      expect(week({ sentLast7Days: 1, waiting: 0, failedLast7Days: 0, scheduled: 0 })).toContain(
        "1 reminder sent",
      );
      expect(week({ sentLast7Days: 6, waiting: 0, failedLast7Days: 0, scheduled: 0 })).toContain(
        "6 reminders sent",
      );
    });

    /**
     * ⚠️ A QUIET WEEK AND AN IDLE PRODUCT ARE NOT THE SAME THING (found by
     * walking, 2026-08-18). This line said "Eva hasn't needed to chase anyone"
     * on a Home screen showing £45,711 outstanding with six reminders already
     * scheduled. The customer's real question is whether Eva is going to do
     * anything, and only the date answers it.
     */
    it("names the next reminder's date when the week was quiet but a plan exists", () => {
      const line = week({ sentLast7Days: 0, waiting: 0, failedLast7Days: 0, scheduled: 6 }, [
        { scheduledDate: "2026-09-15" },
      ]);
      expect(line).toContain("2026-09-15");
      expect(line).not.toContain("hasn't needed to chase");
    });

    /** With nothing scheduled the old sentence is the true one — keep it. */
    it("falls back to the quiet-week line when there is genuinely no plan", () => {
      const line = week({ sentLast7Days: 0, waiting: 0, failedLast7Days: 0, scheduled: 0 }, []);
      expect(line).toContain("hasn't needed to chase");
    });

    /** A busy week is still reported as a busy week; the plan does not hijack it. */
    it("still reports what was sent when the week was not quiet", () => {
      const line = week({ sentLast7Days: 3, waiting: 0, failedLast7Days: 0, scheduled: 6 }, [
        { scheduledDate: "2026-09-15" },
      ]);
      expect(line).toContain("3 reminders sent");
      expect(line).not.toContain("2026-09-15");
    });
  });
});
