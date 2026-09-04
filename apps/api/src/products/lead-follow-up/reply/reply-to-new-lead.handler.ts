import { Injectable } from "@nestjs/common";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import type { NewLead, NewLeadHandler } from "../../../platform/leads/new-lead-handler.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { LeadReplyService } from "./lead-reply.service.js";

/**
 * The lead product's answer to "a lead just arrived" (slice 3.1c-3).
 *
 * ⚠️ THIS CLASS IS THE WHOLE OF THE PRODUCT'S CONNECTION TO INTAKE, AND IT IS
 * DELIBERATELY THIS THIN. The mailbox capability knows only the
 * `NewLeadHandler` interface; it never learns that a product called Lead
 * Follow-up exists, let alone that it sends email. The direction of the arrow
 * is the point — products depend on capabilities, never the reverse.
 *
 * When Lead Follow-up by Call (ruling 14) or the CRM (ruling 16) wants to know
 * a lead arrived, it registers its own handler beside this one and nothing in
 * `capabilities/mailbox` changes.
 */
@Injectable()
export class ReplyToNewLeadHandler implements NewLeadHandler {
  constructor(
    private readonly replies: LeadReplyService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReplyToNewLeadHandler.name);
  }

  async onNewLead({ organisationId, leadId }: NewLead): Promise<void> {
    /**
     * ⚠️ IT OWNS ITS FAILURES RATHER THAN RELYING ON THE DISPATCHER'S CATCH.
     * The dispatcher does catch — a webhook that has already stored an enquiry
     * must never fail because a product could not answer it — but a handler
     * written to be caught is one nobody can reason about, and the interface
     * says so. `answer` already turns every business outcome into a recorded
     * row; what is left here is a genuine fault, and it belongs in OUR log with
     * OUR context rather than as an anonymous line in the capability's.
     */
    try {
      const outcome = await this.replies.answer(organisationId, leadId);
      if (outcome.status !== "sent") {
        this.logger.info({ organisationId, leadId, outcome }, "no automatic reply was sent");
      }
    } catch (error) {
      this.logger.error(
        { organisationId, leadId, err: error instanceof Error ? error.message : String(error) },
        "answering an enquiry faulted; the enquiry itself is stored and safe",
      );
    }
  }
}
