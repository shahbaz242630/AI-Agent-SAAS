import { Module } from "@nestjs/common";
import { REPLY_DECISION_PROVIDER } from "./reply-decision.js";
import { RuleBasedReplyDecisionProvider } from "./rule-based-reply-decision.provider.js";

/**
 * The composition root for "does this enquiry deserve a reply?" (slice 3.1c-2).
 *
 * ⚠️ THE ONE LINE THE AI UPDATE CHANGES, AND THAT IS THE WHOLE POINT OF THE
 * SEAM. Founder ruling 54: *"option 1 but offcourse AI later stage .. we will
 * launch AI as our update"*. When that lands, it is a new class implementing
 * `ReplyDecisionProvider` and `useClass` below pointing at it — not a change to
 * anything that consumes the decision.
 *
 * ⚠️ `useClass`, NOT `useValue`. The rules are stateless today and a plain
 * instance would work, but an AI provider will need injected configuration and
 * an HTTP client, and swapping the registration style at the same time as the
 * implementation is two changes wearing one commit. `MAIL_PROVIDERS` learned
 * this: its comment records that registering a separately-constructed adapter
 * left test overrides pointing at nothing while the real client ran underneath.
 *
 * ⚠️ ITS OWN MODULE RATHER THAN A PROVIDER ON THE TEMPLATES ONE. The templates
 * module is about the words a customer edits; this is about whether anything is
 * sent at all. 3.1c-3's reply path needs the second and not the first, and a
 * module that drags in a `TemplatesService` to ask a yes/no question is how a
 * dependency graph stops meaning anything.
 */
@Module({
  providers: [{ provide: REPLY_DECISION_PROVIDER, useClass: RuleBasedReplyDecisionProvider }],
  exports: [REPLY_DECISION_PROVIDER],
})
export class ReplyDecisionModule {}
