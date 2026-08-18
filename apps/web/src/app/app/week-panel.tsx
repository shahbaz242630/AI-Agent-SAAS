import type { ReminderActivityDto } from "@eva/types";
import { Card, StatusPill } from "@/components/ui";
import { chaseSummary } from "@/lib/dashboard";
import { stageLabel, statusLabel, statusTone } from "@/lib/reminder-activity";

/**
 * Eva's week: the summary, the three counters, and the last few rows
 * (2026-08-09 design handoff).
 *
 * ⚠️ THE COUNTERS ARE NOT ALL THE SAME COLOUR, AND THAT IS THE POINT. "Sent" is
 * ink because it is just news; "waiting" is amber and "didn't send" is red
 * because they are the two a customer may need to act on. A row of three
 * identical numbers makes the reader do the triage the screen should have done.
 *
 * ⚠️ A ZERO STILL SHOWS. Hiding the "didn't send" counter when it is 0 would
 * make its absence ambiguous — is nothing broken, or is the panel broken?
 *
 * Hook-free so it can be rendered in a plain node test.
 */
export function WeekPanel({ activity }: { activity: ReminderActivityDto }) {
  const { counts, recent } = activity;
  return (
    <Card className="flex flex-col gap-4 px-6 py-4.5">
      <div className="flex flex-wrap items-center gap-7">
        <p className="flex-1 text-[13px] text-muted-foreground">
          {chaseSummary(activity, dayMonth)}
        </p>
        <Counter value={counts.sentLast7Days} label="sent" />
        <Counter value={counts.waiting} label="waiting" tone="warn" />
        <Counter value={counts.failedLast7Days} label="didn't send" tone="bad" />
      </div>

      {/* Nothing yet is a real and good answer — an empty table would read as a
          failure to load, so the rows simply do not appear. */}
      {recent.length > 0 && (
        <div className="overflow-x-auto border-t border-hairline pt-1">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr className="text-[11.5px] font-semibold tracking-[0.04em] text-faint uppercase">
                <th className="py-2 font-semibold">Date</th>
                <th className="py-2 font-semibold">Client</th>
                <th className="py-2 font-semibold">Invoice</th>
                <th className="py-2 font-semibold">Stage</th>
                <th className="py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row) => (
                <tr key={row.id} className="border-t border-hairline text-[13px]">
                  {/* The API sends a calendar date already resolved in the ORG's
                      timezone, so it is sliced, never re-derived here. */}
                  <td className="py-2.5 text-muted-foreground">{dayMonth(row.scheduledDate)}</td>
                  <td className="py-2.5 font-semibold">{row.customerName}</td>
                  <td className="py-2.5 text-link">{row.invoiceNumber}</td>
                  <td className="py-2.5 text-muted-foreground">{stageLabel(row.stageKey)}</td>
                  <td className="py-2.5">
                    <StatusPill tone={statusTone(row.status)}>{statusLabel(row.status)}</StatusPill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Counter({ value, label, tone }: { value: number; label: string; tone?: "warn" | "bad" }) {
  return (
    <span className="flex items-baseline gap-2">
      <span
        className={`text-[22px] font-bold ${
          tone === "bad" ? "text-danger" : tone === "warn" ? "text-warning-strong" : ""
        }`}
      >
        {value}
      </span>
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
    </span>
  );
}

/**
 * "2026-08-08" → "8 Aug".
 *
 * ⚠️ SPLIT, NEVER PARSED INTO A `Date`. `new Date("2026-08-08")` is midnight
 * UTC, and formatting that back in a timezone west of Greenwich prints the 7th.
 * The API already resolved this to a calendar day in the organisation's
 * timezone; re-deriving it can only lose that.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dayMonth(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  const index = Number(month) - 1;
  if (!day || !MONTHS[index]) return isoDate;
  return `${Number(day)} ${MONTHS[index]}`;
}
