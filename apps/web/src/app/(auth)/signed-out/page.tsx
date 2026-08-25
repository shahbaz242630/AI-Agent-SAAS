import {
  AUTH_PANELS,
  AuthFrame,
  AuthHeading,
  AuthOutlineLink,
  AuthPrimaryLink,
  SuccessDisc,
} from "../auth-frame";

/**
 * Where signing out lands (2026-08-09 design handoff).
 *
 * ⚠️ IT REPLACED A REDIRECT TO `/sign-in`, WHICH SAID THE WRONG THING. Landing
 * on a sign-in form after choosing to leave reads as "that didn't work, try
 * again" — the same screen a failed session expiry produces. The thing a
 * customer actually needs to know at this moment is that walking away does not
 * stop the chasing they have already set up.
 *
 * ⚠️ THE DESIGN SAYS "Back to eva.co.uk" AND WE DO NOT OWN THAT DOMAIN. It is
 * one of the four landing-page decisions still waiting on the founder, and
 * putting a brand's name on a button that goes somewhere else is exactly the
 * kind of small lie this product cannot afford.
 *
 * Anonymous-only: the proxy sends a signed-in visitor to /app, because telling
 * somebody they are signed out while they are signed in is worse than useless.
 *
 * ⚠️ IT ALSO CATCHES THE TWO-DAY IDLE SIGN-OUT, and that arrival needs
 * different words. Somebody who chose to leave already knows why they are here;
 * somebody who came back to a session we ended does not, and "You're signed
 * out" with no reason reads as a fault in the product. `?reason=idle` is set by
 * the proxy — it decides copy and nothing else, so a visitor typing it into the
 * address bar changes only which sentence they read.
 *
 * ⚠️ IT IS THE SESSION THAT WENT IDLE, NEVER THE ACCOUNT, AND THE WORDS HAVE TO
 * SAY SO. This sentence used to read "nobody had used this account for two
 * days", which is a sentence the product cannot know is true: the proxy's half
 * of the rule has always been per-browser, and the API's half became
 * per-session on 2026-08-25 (ruling 37). Somebody who uses Eva daily on their
 * phone and rarely on the laptop would be told nobody had touched their
 * account — false, and about security, which is the worst place to be caught
 * being loose. Say "here".
 */
export default async function SignedOutPage({
  searchParams,
}: {
  // Next 16: `searchParams` is a Promise and must be awaited.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const idle = (await searchParams).reason === "idle";

  return (
    <AuthFrame panel={AUTH_PANELS.signedOut}>
      <SuccessDisc />
      <AuthHeading
        title={idle ? "Signed out after two days" : "You're signed out"}
        subtitle={
          idle
            ? "Eva hadn't been used here for two days, so we ended the session to keep your account safe. Nothing stopped — reminders already scheduled still went out, and it is all on the record."
            : "Eva carries on without you — reminders already scheduled still send, and everything will be on the record when you're back."
        }
      />
      <AuthPrimaryLink href="/sign-in">Sign back in</AuthPrimaryLink>
      <AuthOutlineLink href="/">Back to the home page</AuthOutlineLink>
    </AuthFrame>
  );
}
