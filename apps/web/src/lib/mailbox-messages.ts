/**
 * What a disconnect cost, in one sentence (slice 1.6b, ruling 3).
 *
 * A pure function in `lib` rather than a helper in the page: it is the single
 * guarantee ruling 3 makes — "the UI states how many clients moved. Never
 * silent" — every branch is a number-agreement trap, and this project has
 * shipped "lowering to 1 seats" and "If you arethe administrator" through a
 * fully green gate. Here it is testable without rendering a page.
 */
export function disconnectMessage(moved: number, unfiled: number, to: string | null): string {
  /**
   * No mailbox left. Naming an address that no longer exists would be worse
   * than admitting the chasing has stopped — and this is the one outcome that
   * silently costs the customer money.
   */
  if (!to) {
    const stranded = moved + unfiled;
    if (stranded === 0) return "Mailbox disconnected. Nothing is connected now.";
    return `Mailbox disconnected. That was your last mailbox, so ${
      stranded === 1 ? "1 client is" : `${stranded} clients are`
    } no longer being chased — connect another to resume.`;
  }

  /**
   * TWO groups, and they are different people. `moved` were filed under the
   * mailbox that just went. `unfiled` were never filed at all and follow the
   * DEFAULT wherever it goes — so they only move when the default itself is
   * disconnected, and by ruling 1 they are usually the majority. Reporting
   * only the first said "Mailbox disconnected." while hundreds quietly changed
   * the address they are chased from.
   */
  const parts: string[] = [];
  if (moved > 0) parts.push(moved === 1 ? "1 client filed there" : `${moved} clients filed there`);
  if (unfiled > 0) {
    parts.push(unfiled === 1 ? "1 client you hadn't filed" : `${unfiled} clients you hadn't filed`);
  }
  if (parts.length === 0) return "Mailbox disconnected.";
  // Singular only when exactly ONE client moved in total. Keyed on the total
  // rather than on which branch built the phrase — that spelling gives
  // "1 client you hadn't filed are now chased".
  return `Mailbox disconnected. ${parts.join(" and ")} ${
    moved + unfiled === 1 ? "is" : "are"
  } now chased from ${to}.`;
}

/**
 * What a replace will cost, stated BEFORE the customer commits to it — the
 * other half of ruling 3, and the reason "disconnect then reconnect" is not an
 * acceptable substitute.
 *
 * TWO INDEPENDENT FACTS, and they were conflated. The default-status clause
 * used to hang off `filed > 0`, so any mailbox with clients filed under it
 * announced that its default status moved across — whether or not it had ever
 * been the default. Seen on staging 2026-08-03 replacing a non-default mailbox
 * holding two clients: true sentence, false implication.
 *
 * Here for the same reason as `disconnectMessage`: it is testable without
 * rendering a page, and copy is what this project keeps shipping broken through
 * a green gate.
 */
export function replaceMessage(emailAddress: string, filed: number, isDefault: boolean): string {
  const clients =
    filed > 0
      ? `Its ${filed === 1 ? "client moves" : `${filed} clients move`} across.`
      : "Anything filed under it moves across.";
  // Only mentioned when it is TRUE. A mailbox that is not the default has no
  // default status to carry, and saying so implies it does.
  const fallback = isDefault
    ? " It is the default for unfiled clients, and that moves across too."
    : "";
  return `Swap ${emailAddress} for a different address. ${clients}${fallback}`;
}
