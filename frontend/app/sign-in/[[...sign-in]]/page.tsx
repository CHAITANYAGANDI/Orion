import { SignIn } from "@clerk/nextjs";
import { AuthScreen } from "@/components/auth-screen";

/**
 * Signing in.
 *
 * <p>A catch-all segment because Clerk routes its own sub-steps under this
 * path — a second factor, an emailed code, a password reset — and each of those
 * is a URL. A plain `/sign-in` route would 404 on every one of them.
 *
 * <p>Clerk's own component rather than a form of ours. Orion does not
 * authenticate anybody and deliberately holds no password: what is signed in
 * here is verified against Clerk's JWKS by
 * `AuthenticationFilter`, and everything a credential needs around it —
 * verification, reset, lockout, a second factor — belongs to the thing that
 * issues it.
 */
export default function SignInPage() {
  return (
    <AuthScreen
      title="Sign in to Orion"
      subtitle="Your meetings, transcripts and notes are scoped to your account."
    >
      {/* `fallbackRedirectUrl`, not `forceRedirectUrl`: the middleware puts the
          page you were actually asking for on the URL, and forcing /home would
          throw it away. A bookmarked meeting should open the meeting. */}
      <SignIn signUpUrl="/sign-up" fallbackRedirectUrl="/home" />
    </AuthScreen>
  );
}
