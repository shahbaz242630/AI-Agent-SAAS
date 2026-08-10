import { AuthForm } from "../auth-form";
import { AUTH_PANELS, AuthFrame } from "../auth-frame";

export default function SignInPage() {
  return (
    <AuthFrame panel={AUTH_PANELS.signIn} back={{ href: "/", label: "Back" }}>
      <AuthForm mode="sign-in" />
    </AuthFrame>
  );
}
