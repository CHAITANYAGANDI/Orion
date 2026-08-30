"use client";

/**
 * The parts a sign-in form is made of, so the three screens that use them
 * cannot drift apart.
 *
 * <p>Not shadcn's `Input` and `Button` directly: those are sized for dense
 * application chrome — 36px rows beside a hundred other controls — and these
 * screens have one job and the whole viewport to do it in. Taller targets,
 * quieter borders, and a focus ring that is actually visible on a dark ground.
 *
 * <p>Everything here is a plain element with a label tied to it. A sign-in
 * form is the one place in a product where a password manager, a screen reader
 * and a keyboard all have to work first time.
 */

import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A labelled field.
 *
 * <p>`autoComplete` is required rather than optional. It is what lets a
 * password manager fill this in, and the difference between `current-password`
 * and `new-password` is the difference between offering to fill and offering to
 * generate — getting it wrong is a form that fights the browser.
 */
export function Field({
  label,
  hint,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  /** Shown to the right of the label: "Forgot?", "At least 8 characters". */
  hint?: React.ReactNode;
  autoComplete: string;
}) {
  const id = React.useId();
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium">
          {label}
        </label>
        {hint ? <span className="text-[12px] text-muted-foreground">{hint}</span> : null}
      </div>
      <input
        id={id}
        {...props}
        className={cn(
          "h-11 w-full rounded-lg border bg-card px-3.5 text-[15px] text-foreground",
          "placeholder:text-muted-foreground/60",
          "outline-none transition-colors",
          "focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:opacity-50",
          props.className,
        )}
      />
    </div>
  );
}

/**
 * The one action on the screen.
 *
 * <p>Light on dark, because `--primary` in this product is near-white ink
 * rather than a brand hue — the same button the app uses, at the size this
 * screen wants. Disabled while in flight, and the label says what is happening
 * rather than spinning silently.
 */
export function SubmitButton({
  children,
  busy,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      type="submit"
      {...props}
      disabled={busy || props.disabled}
      className={cn(
        "flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4",
        "text-[15px] font-medium text-primary-foreground",
        "transition-opacity hover:opacity-90",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

/**
 * Continue with Google.
 *
 * <p>Above the email fields, not below, because it is the shorter road and most
 * people take it. The mark is Google's own four-colour G: their brand
 * guidelines require it unaltered, and a monochrome stand-in on a button that
 * says Google is the kind of detail that reads as a phishing page.
 */
export function GoogleButton({
  onClick,
  busy,
  label,
}: {
  onClick: () => void;
  busy?: boolean;
  /** "Continue with Google" reads the same for a sign-in and a sign-up. */
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        "flex h-11 w-full items-center justify-center gap-3 rounded-lg border bg-card px-4",
        "text-[15px] font-medium",
        "transition-colors hover:bg-accent",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <GoogleMark className="h-[18px] w-[18px]" />
      )}
      {label}
    </button>
  );
}

function GoogleMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** A hairline with a word in it, for the seam between the two ways in. */
export function OrDivider() {
  return (
    <div className="flex items-center gap-4">
      <span className="h-px flex-1 bg-border" />
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        or
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * What went wrong, where it can be seen.
 *
 * <p>`role="alert"` so it is announced: somebody using a screen reader submits
 * a form and otherwise hears nothing at all. Above the fields rather than
 * beneath the button, because that is where the eye returns after a failed
 * submit.
 */
export function FormError({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-[13px] text-foreground"
    >
      {children}
    </p>
  );
}
