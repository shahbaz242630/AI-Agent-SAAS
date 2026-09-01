/**
 * "Is this worth showing a human at all?" — the provider's answer (slice
 * 3.1c-0b, ruling 32).
 *
 * ⚠️ THIS IS AMAZON'S JUDGEMENT, NOT OURS, AND THAT IS THE POINT. Resend runs
 * on SES, and SES has already scanned every message before it reaches us —
 * against infrastructure and corpora we could not begin to reproduce. It hands
 * the result over as plain headers we were already storing and had never read.
 * Writing our own keyword rules instead would be worse at the job and would be
 * ours to maintain forever.
 *
 * ⚠️ IT ONLY REFUSES WHAT THE PROVIDER IS CONFIDENT ABOUT. `FAIL` means SES
 * decided; `GRAY`, `PROCESSING_FAILED` and a missing header all mean it did
 * not, and those go through to the book where a human reads them. That is
 * ruling 32 exactly: *"err toward silence; the uncertain middle waits for a
 * human"* — silence for the certain cases, a person for the rest. Widening
 * this to GRAY would start throwing away real enquiries, and a lost enquiry is
 * a lost customer that nobody ever finds out about.
 *
 * ⚠️ WHAT IT IS NOT. This catches bulk spam and malware. It does NOT answer
 * "is this an enquiry, or a marketing email from a real company that passes
 * every check?" — a legitimate newsletter passes SPF, DKIM and the spam
 * verdict, because it IS legitimate mail; it is simply not somebody asking for
 * work. Telling those apart is a question about INTENT, it needs to read the
 * message, and it belongs with 3.1c's review queue. Do not grow this file into
 * that.
 */

/**
 * SES writes one of these. `GRAY` is "probably spam but not certain" and
 * `PROCESSING_FAILED` is "the scan itself did not complete".
 * https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications.html
 */
export type SesVerdict = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED" | "UNKNOWN";

const SPAM_HEADER = "x-ses-spam-verdict";
const VIRUS_HEADER = "x-ses-virus-verdict";

/**
 * Headers arrive lower-cased from the intake path, but a provider that changes
 * its casing must not silently turn every verdict into UNKNOWN — which would
 * disable this check with nothing failing anywhere.
 */
function header(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}

function readVerdict(headers: Record<string, string>, name: string): SesVerdict {
  const raw = header(headers, name)?.trim().toUpperCase();
  if (raw === "PASS" || raw === "FAIL" || raw === "GRAY" || raw === "PROCESSING_FAILED") {
    return raw;
  }
  return "UNKNOWN";
}

export interface InboundVerdicts {
  spam: SesVerdict;
  virus: SesVerdict;
}

export function readInboundVerdicts(headers: Record<string, string>): InboundVerdicts {
  return {
    spam: readVerdict(headers, SPAM_HEADER),
    virus: readVerdict(headers, VIRUS_HEADER),
  };
}

/**
 * Why this message must not become a lead, or `null` to carry on.
 *
 * The string is stored on the message row as its failure reason and read by a
 * human looking at why something never arrived, so it says what happened in
 * words rather than a code.
 */
export function refusalReason(headers: Record<string, string>): string | null {
  const { spam, virus } = readInboundVerdicts(headers);
  /**
   * ⚠️ VIRUS FIRST, AND IT IS NOT THE SAME ANSWER AS SPAM. Malware is refused
   * whatever else is true of the message, and it is named separately so that a
   * customer asking "where did that go?" gets told the real reason rather than
   * a generic "we thought it was junk".
   */
  if (virus === "FAIL") return "the provider found malware in it, so it was not filed";
  if (spam === "FAIL") return "the provider judged it spam, so it was not filed";
  return null;
}
