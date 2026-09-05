import { Injectable } from "@nestjs/common";
import type { TenantTx } from "../../platform/permissions/permissions.js";

/**
 * "Which number does this product send from?" (slice 3.4a) — the sibling of
 * `MailboxesService.resolveSendingMailbox`.
 *
 * ⚠️ THE ONE WAY A PRODUCT LEARNS ABOUT A CONNECTION. `channel_connections`
 * belongs to this capability (`table-ownership.ts`), and
 * `architecture.spec.ts` fails any product file that reads it directly. The
 * product asks this question and gets back the little it needs to address a
 * send; how a connection is stored, and later how its token is kept, stays
 * on this side of the line.
 *
 * ⚠️ PER PRODUCT, LIKE A MAILBOX (rulings 36/49). A number is connected FOR a
 * product; asking for Lead Follow-up's number can never return the
 * receptionist's.
 */
export interface SendingNumberResolution {
  connection: {
    id: string;
    /** Meta's phone number id — what a send is addressed to. */
    phoneNumberId: string;
    /** The display number a human knows it by, for the record of what was sent from where. */
    displayName: string | null;
  };
}

@Injectable()
export class WhatsAppNumbersService {
  /**
   * The live, connected WhatsApp number for one product in the caller's
   * tenant transaction, or null when there is none. A connection that
   * `needs_reconnect` is not returned: the product records "nothing was
   * sent" with the reason, which is the honest outcome, rather than
   * attempting a send the token would refuse.
   */
  async resolveSendingNumber(
    tx: TenantTx,
    organisationId: string,
    moduleKey: string,
    /**
     * The connection the conversation arrived on, when there is one. A reply
     * must leave from the number the person wrote to — the 24-hour window is
     * a fact about that pair — so a thread's own connection is asked for by
     * id and no other number is substituted for it.
     */
    options: { connectionId?: string | null } = {},
  ): Promise<SendingNumberResolution | null> {
    const row = await tx.channelConnection.findFirst({
      where: {
        organisationId,
        moduleKey,
        channel: "whatsapp",
        status: "connected",
        deletedAt: null,
        ...(options.connectionId ? { id: options.connectionId } : {}),
      },
      select: { id: true, externalAssetId: true, displayName: true },
      orderBy: { createdAt: "asc" },
    });
    if (!row || !row.externalAssetId) return null;
    return {
      connection: { id: row.id, phoneNumberId: row.externalAssetId, displayName: row.displayName },
    };
  }
}
