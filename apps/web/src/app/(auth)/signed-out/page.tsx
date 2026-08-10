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
 */
export default function SignedOutPage() {
  return (
    <AuthFrame panel={AUTH_PANELS.signedOut}>
      <SuccessDisc />
      <AuthHeading
        title="You're signed out"
        subtitle="Eva carries on without you — reminders already scheduled still send, and everything will be on the record when you're back."
      />
      <AuthPrimaryLink href="/sign-in">Sign back in</AuthPrimaryLink>
      <AuthOutlineLink href="/">Back to the home page</AuthOutlineLink>
    </AuthFrame>
  );
}
