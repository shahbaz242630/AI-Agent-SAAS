import { owedHeadline, type CurrencyTotal } from "@/lib/dashboard";
import { formatMoney } from "@/lib/money";

/**
 * What the organisation is owed, one card per currency (Slice 1.9).
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
export function OwedPanel({ rows }: { rows: CurrencyTotal[] }) {
  return (
    <div className="flex w-full flex-col gap-3">
      <p className="text-sm text-muted-foreground">{owedHeadline(rows)}</p>
      {rows.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {rows.map((row) => (
            <li
              key={row.currency}
              className="flex flex-col gap-1 rounded-[var(--radius-card)] bg-muted px-5 py-4"
            >
              <span className="text-2xl font-bold tabular-nums">
                {formatMoney(row.outstandingMinorUnits, row.currency)}
              </span>
              <span className="text-xs text-muted-foreground">
                {row.invoiceCount === 1 ? "1 invoice" : `${row.invoiceCount} invoices`} in{" "}
                {row.currency}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
