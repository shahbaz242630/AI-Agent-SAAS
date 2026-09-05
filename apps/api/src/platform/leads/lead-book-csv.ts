import { REPLY_CHANNEL_LABELS, replyChannelForLeadSource } from "@eva/types";

/**
 * The fields a row of the file is made of — named here rather than imported
 * from the service, because the service imports this file and a type import
 * back the other way is still a cycle to the boundary check.
 */
export interface LeadCsvRow {
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  source: string;
  enquiry: string | null;
  status: string;
  receivedAt: Date;
  firstRespondedAt: Date | null;
  stage: { name: string };
}

/**
 * The enquiry book as a file, for the customer's own records (founder,
 * 2026-09-05: *"the user should be able to download a csv of the enquiries"*).
 *
 * ⚠️ TIMES ARE IN THE ORGANISATION'S ZONE, AND THE HEADER SAYS WHICH. A
 * spreadsheet has no timezone; an ISO instant in UTC would read as an hour
 * wrong to a customer in London and four hours wrong to one in Dubai, and
 * they would trust the file over their memory.
 *
 * ⚠️ A UTF-8 BYTE ORDER MARK, BECAUSE EXCEL. Without it Excel on Windows
 * opens the file in the machine's legacy code page and every name with an
 * accent, and every £, comes out as noise.
 */
export function leadBookCsv(rows: readonly LeadCsvRow[], timezone: string): string {
  const header = [
    "Name",
    "Email",
    "Phone",
    "Channel",
    "What they asked",
    `Received (${timezone})`,
    `Answered (${timezone})`,
    "Stage",
    "Do not contact",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.contactName ?? "",
        row.contactEmail ?? "",
        row.contactPhone ?? "",
        channelLabel(row.source),
        row.enquiry ?? "",
        stamp(row.receivedAt, timezone),
        row.firstRespondedAt ? stamp(row.firstRespondedAt, timezone) : "",
        row.stage.name,
        row.status === "do_not_contact" ? "yes" : "no",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function channelLabel(source: string): string {
  const channel = replyChannelForLeadSource(source);
  if (channel) return REPLY_CHANNEL_LABELS[channel];
  // The retired call-shaped sources: said the way the book says them.
  return source.replace(/_/g, " ");
}

/**
 * ⚠️ DEFUSED, NOT JUST QUOTED. To Excel and to Google Sheets a cell beginning
 * with `=`, `+`, `-` or `@` is a formula, and an enquiry is text a stranger
 * typed: `=HYPERLINK(...)` in a message becomes something that runs on the
 * customer's machine the day they open their own records. A leading
 * apostrophe makes it text again (OWASP, CSV injection); the customer sees
 * the apostrophe, which is the price of not running the stranger's formula.
 *
 * A phone number written `+44 7700 900123` is left alone: it is digits and
 * separators, not a formula, and an apostrophe on every phone number would
 * make the column useless for the one thing it is exported for.
 */
export function csvCell(value: string): string {
  const looksLikePhone = /^[+-][\d\s().-]+$/.test(value);
  const dangerous = /^[=+\-@\t\r]/.test(value) && !looksLikePhone;
  const text = dangerous ? `'${value}` : value;
  return `"${text.replace(/"/g, '""')}"`;
}

/** `2026-09-05 11:39`, in the zone given — the form a spreadsheet sorts. */
export function stamp(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  // en-GB can render midnight as "24"; a spreadsheet wants "00".
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}`;
}
