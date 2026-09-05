import { moduleHref, type ReplyChannel } from "@eva/types";

/**
 * The words of the Replies screen that depend on state (ruling 89) — pure, so
 * a node test can hold them to their claims.
 */

/** Where one channel's replies leave from, as the api reports it. */
export type SendsFrom = { from: string | null } | null;

export interface SendsFromLine {
  text: string;
  /** Where to go to fix it, when there is somewhere to go. */
  action: { href: string; label: string } | null;
}

const MAILBOX = moduleHref("lead_follow_up", "mailbox");

/**
 * One line under a channel's heading: the connected address or number, or
 * the honest fact that nothing is connected.
 *
 * ⚠️ EMAIL LINKS TO WHERE A MAILBOX IS CONNECTED; WHATSAPP LINKS NOWHERE,
 * because there is no screen yet on which a customer connects a number (the
 * Embedded Signup slice). A link to a page that does not exist would be the
 * send-by-hand mistake again, one level down.
 */
export function sendsFromLine(channel: ReplyChannel, sendsFrom: SendsFrom): SendsFromLine {
  switch (channel) {
    case "email":
      return sendsFrom
        ? { text: `Replies leave from ${sendsFrom.from ?? "your mailbox"}.`, action: null }
        : {
            text: "Nothing connected yet, so these cannot go out.",
            action: { href: MAILBOX, label: "Connect a mailbox" },
          };
    case "whatsapp":
      return sendsFrom
        ? {
            text: `Replies leave from ${sendsFrom.from ?? "your WhatsApp number"}, under your business name.`,
            action: null,
          }
        : {
            text: "No WhatsApp number is connected to Eva yet, so these cannot go out.",
            action: null,
          };
  }
}

const FIRST_LINE_MAX = 100;

/**
 * What a wording's row shows beside its name: the first line that says
 * anything, cut so a long one cannot push the row to two.
 */
export function firstLine(body: string): string {
  const line =
    body
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX - 1)}…` : line;
}
