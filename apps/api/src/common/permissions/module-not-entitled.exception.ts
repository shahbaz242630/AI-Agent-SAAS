import { HttpStatus } from "@nestjs/common";
import type { ModuleKey } from "@eva/types";
import { StructuredHttpException } from "../errors/structured-http.exception.js";

/** Human-readable product names, so the message reads like something a person
 *  wrote rather than a database value leaking into a sentence. */
const MODULE_NAMES: Record<ModuleKey, string> = {
  email_credit_controller: "Invoice Chasing",
  voice_credit_controller: "Voice Credit Control",
  lead_follow_up_agent: "Lead Follow-Up",
  ai_receptionist: "AI Receptionist",
};

/**
 * 402 Payment Required — the organisation has not got this product.
 *
 * Distinct from 403 on purpose, and the distinction is the whole point:
 * **403 means "ask your owner", 402 means "upgrade".** They are different
 * situations with different fixes, and a UI that cannot tell them apart shows
 * one of them a dead end. Same reasoning that made `admin_consent_required` its
 * own callback code in slice 1.6.
 *
 * Structured because the web app must branch on it rather than read the prose:
 * `code` is stable, the message is not.
 */
export class ModuleNotEntitledException extends StructuredHttpException {
  constructor(module: ModuleKey) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        code: "module_not_entitled",
        module,
        message: `Your organisation doesn't have ${MODULE_NAMES[module]}. Add it to use this.`,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
