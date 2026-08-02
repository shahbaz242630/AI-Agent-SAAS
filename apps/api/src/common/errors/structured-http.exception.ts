import { HttpException } from "@nestjs/common";

/**
 * An HttpException whose JSON body is DELIBERATE and must reach the client
 * intact, field for field.
 *
 * `GlobalExceptionFilter` flattens every error response to
 * `{ statusCode, message }`. That is right for the general case — it is what
 * stops a Prisma failure spilling connection strings — but it silently
 * discards any structure application code added on purpose. A client that
 * needs to *branch* on a situation cannot do it by pattern-matching English:
 * that is precisely defect F4 from slice 1.6, where the API's real message was
 * thrown away and the customer got "please try again" instead.
 *
 * So preservation is OPT-IN rather than automatic. Extending this class is a
 * statement that every field in the body was chosen with the client in mind.
 * Anything not extending it keeps today's flattening, unchanged.
 *
 * ⚠️ The body of a subclass is PUBLIC. Never build one from a caught error, for
 * the same reason the filter exists at all — see the standing rule at the top
 * of `global-exception.filter.ts`.
 */
export abstract class StructuredHttpException extends HttpException {}
