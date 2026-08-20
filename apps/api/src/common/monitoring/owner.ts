import { SetMetadata } from "@nestjs/common";

/**
 * Which part of the system a log line, a fault and a Sentry event belong to.
 *
 * ⚠️ THIS EXISTS BECAUSE "THE API THREW A 500" STOPS BEING AN ANSWER AT FIVE
 * PRODUCTS. On 2026-08-19 a defect that had been on production for eight days
 * was found by a human clicking a screen, not by 1,438 tests and not by the
 * log — and the log could not have found it, because nothing in it said which
 * product the failing request belonged to. Founder ruling 13 makes each
 * product independently debuggable; a shared stream with no attribution is the
 * one place that ruling was not honoured.
 *
 * ⚠️ THE STRING IS THE SEARCH. What is written here is what appears in the log
 * and in the Sentry tag, verbatim — `product:invoice-follow-up`, not an id
 * resolved through a lookup nobody has to hand at 2am. Grep the value, find
 * the controller; read the value in Sentry, know the folder.
 *
 * The tag names a FOLDER, not an entitlement key. `product:invoice-follow-up`
 * is where the code lives; `email_credit_controller` is what the customer
 * bought. They are one lookup apart (the product's `product.ts` holds both) and
 * conflating them would mean renaming a price could silently unname a log.
 */
export type OwnerTag = "platform" | `capability:${string}` | `product:${string}`;

/**
 * What an unlabelled request logs.
 *
 * ⚠️ A VALUE, NOT AN ABSENT FIELD. `product-attribution.spec.ts` fails the
 * build if a controller ships without `@OwnedBy`, so this should be
 * unreachable — but a missing field looks identical to a log nobody thought
 * about, while this one can be searched for and counted. If it ever appears in
 * production, the wall has a hole in it and the log says so out loud.
 */
export const UNATTRIBUTED = "unattributed";

/** Nest metadata key. Read by `RequestOwnerGuard`, never by business code. */
export const OWNER_METADATA = "eva:owner";

/**
 * Declares which layer a controller belongs to.
 *
 * ⚠️ IT MUST MATCH THE FOLDER THE FILE SITS IN, AND A TEST CHECKS THAT. The
 * decorator cannot be derived from the path at runtime (the path is gone by
 * the time the code is compiled and loaded), so the annotation is written by
 * hand and the wall is a spec that walks the source and compares. Adding a
 * controller without one, or with the wrong one, fails the build.
 */
export const OwnedBy = (owner: OwnerTag) => SetMetadata(OWNER_METADATA, owner);

/**
 * The request property the guard stamps and the exception filter reads.
 *
 * Prefixed because it rides on the express request alongside express's own
 * fields and our `authUser`: a bare `owner` is the kind of name two libraries
 * pick independently.
 */
export interface OwnedRequest {
  evaOwner?: OwnerTag | typeof UNATTRIBUTED;
}

/**
 * Reads the tag the guard stamped.
 *
 * Defensive rather than typed-through: the exception filter catches
 * everything, including requests that failed before any guard ran, and those
 * have no tag at all. Answering `unattributed` is the honest reply for a fault
 * that never reached a controller.
 */
export function ownerOf(request: unknown): string {
  const owner = (request as OwnedRequest | undefined)?.evaOwner;
  return typeof owner === "string" && owner.length > 0 ? owner : UNATTRIBUTED;
}
