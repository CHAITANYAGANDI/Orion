import { SignUp } from "@clerk/nextjs";
import { AuthScreen } from "@/components/auth-screen";

/** Registering. Catch-all for the same reason as sign-in. */
export default function SignUpPage() {
  return (
    <AuthScreen
      title="Create your Recallix account"
      subtitle="100 transcription minutes and 3 imports, for the life of the account. No card."
    >
      <SignUp signInUrl="/sign-in" fallbackRedirectUrl="/home" />
    </AuthScreen>
  );
}
