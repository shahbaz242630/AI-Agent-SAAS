import { Card } from "@/components/ui";
import { overdueLine, owedHeadline, type OwedRow } from "@/lib/dashboard";
import { formatMoney } from "@/lib/money";

/**
 * What the organisation is owed, one card per currency (2026-08-09 design).
 *
 * ⚠️ NO TOTAL ACROSS THE CARDS, AND THERE MUST NEVER BE ONE. Adding AED to GBP
 * gives a confident wrong number; the cards stand alone and the headline names
 * how many currencies there are so a reader does not mentally add them.
 *
 * Hook-free and client-directive-free on purpose, so it can be rendered to a
 * string in a plain node test — the `ReminderStepList` precedent. Money
 * formatting is the thing worth covering: a Kuwaiti amount shown to two decimals
 * is wrong by a factor of ten, and GCC is the next market.
 */
export function OwedPanel({ rows }: { rows: OwedRow[] }) {
  return (
    <div className="flex w-full flex-col gap-2.5">
      <p className="text-[13px] text-muted-foreground">{owedHeadline(rows)}</p>
      {rows.length > 0 && (
        <ul className="flex flex-wrap gap-3">
          {rows.map((row) => {
            /* ⚠️ FORMATTED IN THE ROW'S OWN CURRENCY, never the card's headline
               currency — they are the same code here, and that is exactly the
               kind of thing a later refactor breaks silently. */
            const late = overdueLine({
              formattedOverdue: formatMoney(row.overdueMinorUnits, row.currency),
              invoiceCount: row.overdueCount,
            });
            return (
              <li key={row.currency} className="min-w-[260px] flex-1">
                <Card className="flex h-full flex-col gap-1 px-6 py-5">
                  <span className="text-[11.5px] font-bold tracking-[0.07em] text-faint uppercase">
                    Outstanding · {row.currency}
                  </span>
                  {/*
                   * ⚠️ MONEY IS SET IN THE BODY FACE, NOT THE DISPLAY FACE, AND
                   * THAT IS A DELIBERATE DEPARTURE FROM THE 2026-08-09 DESIGN.
                   * Bricolage Grotesque renders £ (U+00A3) malformed — the
                   * glyph itself comes out doubled, and beside a digit it reads
                   * as a collision. Checked properly before deviating: it is
                   * not kerning, not ligatures, not `tabular-nums`, not the
                   * letter-spacing, not the `opsz` axis, and not a missing
                   * glyph (U+00A3 is inside the loaded latin subset). `$` and
                   * `€` are both fine in the same face; `£` alone is not.
                   *
                   * Sterling is our launch market's currency and this is the
                   * largest number on the home screen. A broken pound sign on
                   * the figure a business reads first is not a typography
                   * preference to lose. Titles keep Bricolage, so the design's
                   * character survives where it does no harm.
                   */}
                  <span className="text-[40px] leading-tight font-bold tracking-[-0.01em]">
                    {formatMoney(row.outstandingMinorUnits, row.currency)}
                  </span>
                  <span className="text-[13px] text-muted-foreground">
                    {row.invoiceCount === 1 ? "1 invoice" : `${row.invoiceCount} invoices`} in{" "}
                    {row.currency}
                  </span>
                  {late && <span className="text-[13px] font-semibold text-danger">{late}</span>}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
