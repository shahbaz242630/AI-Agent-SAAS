import { AuthForm } from "../auth-form";
import { AUTH_PANELS, AuthFrame } from "../auth-frame";

export default function SignUpPage() {
  return (
    <AuthFrame panel={AUTH_PANELS.signUp} back={{ href: "/", label: "Back" }}>
      <AuthForm mode="sign-up" />
    </AuthFrame>
  );
}
