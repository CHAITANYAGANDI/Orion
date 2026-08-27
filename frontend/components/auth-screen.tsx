import Link from "next/link";
import { Mic } from "lucide-react";

/**
 * The frame around Clerk's own sign-in and sign-up cards.
 *
 * <p>Deliberately thin. Everything inside the card — the fields, the error
 * states, the second factor, the emailed code — is Clerk's, because it is
 * Clerk's credential; wrapping it in a Recallix-shaped form would mean owning
 * the parts of a sign-in that go wrong. What this adds is the two things the
 * component cannot know: whose product this is, and the way back out.
 *
 * <p>Not inside the app shell. There is no sidebar, no recording bar and no
 * search here, because none of them can do anything for somebody who is not
 * signed in — and a shell drawn around a sign-in form implies the app behind it
 * is already open.
 */
export function AuthScreen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-12">
      <Link href="/" className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Mic className="h-4 w-4" />
        </span>
        <span className="font-semibold">Recallix AI</span>
      </Link>

      <div className="space-y-1 text-center">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">{subtitle}</p>
      </div>

      {children}
    </div>
  );
}
