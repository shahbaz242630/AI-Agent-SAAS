import {
  moduleHref,
  REPLY_CHANNEL_LABELS,
  REPLY_CHANNELS,
  type LeadPlaybookDto,
  type ReplyChannel,
} from "@eva/types";

/**
 * The words of the Automations screen that depend on state (slice 3.5a,
 * ruling 93; the connection lines from ruling 89) — pure, so a node test can
 * hold them to their claims.
 */

/** Where one channel's replies leave from, as the api reports it. */
export type SendsFrom = { from: string | null } | null;

export interface StateLine {
  text: string;
  /** Where to go to fix it, when there is somewhere to go. */
  action: { href: string; label: string } | null;
}

const MAILBOX = moduleHref("lead_follow_up", "mailbox");

/** The settings tab where the clock lives. Typed once, here, and tested. */
export const OPENING_HOURS_HREF = "/app/settings/opening-hours";

/**
 * One line under a channel's heading: the connected address or number, or
 * the honest fact that nothing is connected.
 *
 * ⚠️ EMAIL LINKS TO WHERE A MAILBOX IS CONNECTED; WHATSAPP LINKS NOWHERE,
 * because there is no screen yet on which a customer connects a number (the
 * Embedded Signup slice). A link to a page that does not exist would be the
 * send-by-hand mistake again, one level down.
 */
export function sendsFromLine(channel: ReplyChannel, sendsFrom: SendsFrom): StateLine {
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

/** What an empty box means, said under it — silence on that channel, chosen. */
export function emptyBoxLine(channel: ReplyChannel): string {
  return `Nothing set, so Eva says nothing on ${REPLY_CHANNEL_LABELS[channel]} for this card.`;
}

/**
 * Why a card's switch cannot be pressed yet, or null when it can.
 *
 * ⚠️ THE OUT-OF-HOURS CARD NEEDS THE CLOCK. Its whole behaviour is "when you
 * are closed"; without opening hours the api refuses the switch (409), and
 * the screen says so before anybody presses it rather than after.
 */
export function switchBlockedLine(
  playbook: Pick<LeadPlaybookDto, "key">,
  openingHoursSet: boolean,
): StateLine | null {
  if (playbook.key === "after_hours" && !openingHoursSet) {
    return {
      text: "Eva needs your opening hours before she can tell when you are closed.",
      action: { href: OPENING_HOURS_HREF, label: "Set opening hours" },
    };
  }
  return null;
}

/**
 * The channels on which the instant reply is on, connected, and has no
 * words — the one state on this screen where "nobody hears back" is true and
 * fixable here. A channel with nothing connected cannot send at all, so a
 * warning about its empty box would be noise (ruling 89's rule, kept).
 */
export function silentChannels(
  playbooks: readonly LeadPlaybookDto[],
  sendsFrom: Record<ReplyChannel, SendsFrom>,
): ReplyChannel[] {
  const instant = playbooks.find((playbook) => playbook.key === "instant_reply");
  if (!instant || !instant.enabled) return [];
  return REPLY_CHANNELS.filter(
    (channel) => instant.wordings[channel] === null && sendsFrom[channel] !== null,
  );
}

/** Whether the one card that answers enquiries is off — said in red at the top. */
export function instantReplyOff(playbooks: readonly LeadPlaybookDto[]): boolean {
  const instant = playbooks.find((playbook) => playbook.key === "instant_reply");
  return !instant || !instant.enabled;
}
