import { HttpStatus } from "@nestjs/common";
import { moduleName, type ModuleKey } from "@eva/types";
import { StructuredHttpException } from "../errors/structured-http.exception.js";

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
        message: `Your organisation doesn't have ${moduleName(module)}. Add it to use this.`,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
