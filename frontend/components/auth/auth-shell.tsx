import Link from "next/link";
import { Mic } from "lucide-react";

/**
 * The frame every screen outside the app shares: sign in, sign up, welcome.
 *
 * <h2>What changed, and why it is ours now</h2>
 *
 * <p>These pages used to be a thin wrapper around Clerk's drop-in components,
 * on the reasoning that Reverie does not authenticate anybody so it should not
 * own the form. That reasoning held for the credential and not for the
 * product: the first screen anyone sees was a third party's, in a third party's
 * type, carrying a third party's name — and it was the one screen where Reverie
 * had to look like something. The credential is still Clerk's. The screen is
 * ours, built on its headless hooks, and nothing on it says Clerk.
 *
 * <h2>The composition</h2>
 *
 * <p>One column, 380px, centred, on the same warm near-black the app uses. No
 * card: a bordered box floating on a dark ground is the shape of a dialog, and
 * this is not interrupting anything. The chrome is the two hairlines and the
 * mono eyebrow, which is the same metadata voice the meeting page sets its
 * timecodes in — so the sign-in reads as the front of this product rather than
 * as a generic form that happens to precede it.
 *
 * <p>The one atmospheric touch is a single soft wash of the product's amber at
 * the top of the viewport, at four percent. It is doing the job a photograph
 * would do on a marketing page: giving the eye somewhere to land before the
 * type starts. Anything more would be decoration on a page whose job is to be
 * got through quickly.
 */
export function AuthShell({
  eyebrow,
  title,
  subtitle,
  children,
  footer,
}: {
  /** Where you are, in the metadata voice: "SIGN IN", "STEP 1 OF 3". */
  eyebrow: string;
  title: string;
  /** One line. What this screen is for, or what happens next. */
  subtitle: React.ReactNode;
  children: React.ReactNode;
  /** The way to the other flow, or out. */
  footer?: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 py-16">
      {/* Ambient, not decorative: it puts a horizon behind the type. Sized in
          vmax so it stays a wash rather than becoming a visible circle on a
          wide screen, and marked aria-hidden because it says nothing. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 h-[60vmax] w-[90vmax] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,hsl(var(--highlight)/0.10),transparent)]"
      />

      <div className="relative w-full max-w-[380px]">
        <Link
          href="/"
          className="group mb-14 flex items-center gap-2.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-primary text-primary-foreground">
            <Mic className="h-3.5 w-3.5" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Reverie</span>
        </Link>

        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          {eyebrow}
        </p>
        {/* Light weight at display size. IBM Plex Sans at 300 has the humanist
            detail that carries a large setting, and the app already speaks it —
            a second display face here would be a second identity. */}
        <h1 className="mt-3 text-[32px] font-light leading-[1.15] tracking-[-0.02em]">{title}</h1>
        <div className="mt-3 text-[15px] leading-relaxed text-muted-foreground">{subtitle}</div>

        <div className="mt-10">{children}</div>

        {footer ? (
          <div className="mt-8 border-t pt-6 text-[13px] text-muted-foreground">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
