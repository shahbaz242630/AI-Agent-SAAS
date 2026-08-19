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
  /**
   * `modules` is every product that would satisfy the permission, and holding
   * **any one** of them is enough. Naming only the first would tell a customer
   * to buy something they do not need, and telling them what to buy is the
   * entire job of a 402.
   */
  constructor(modules: readonly [ModuleKey, ...ModuleKey[]]) {
    const names = modules.map(moduleName);
    // "A", or "A or B", or "A, B or C" — the last join is the one that has to
    // be "or", because ANY of them unlocks this and "and" would read as all.
    const listed =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        code: "module_not_entitled",
        modules,
        message: `Your organisation doesn't have ${listed}. Add ${
          names.length === 1 ? "it" : "one"
        } to use this.`,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
