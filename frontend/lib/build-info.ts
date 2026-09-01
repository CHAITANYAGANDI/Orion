/**
 * The documents that govern this deployment, where somebody has written any.
 *
 * <p>Reverie ships no terms of service and no privacy policy of its own: those
 * are documents somebody has to write and be bound by, not strings a UI can
 * supply. Set `NEXT_PUBLIC_TERMS_URL` and `NEXT_PUBLIC_PRIVACY_URL` and the
 * settings footer links to them; leave them unset and the footer does not
 * render at all.
 *
 * <h2>What left this file</h2>
 *
 * <p>`BUILD_VERSION`, `BUILD_COMMIT` and the `BUILD_LINE` they composed —
 * "Version 0.0.0 — dev build" at the foot of Account Settings. The idea was
 * that a bug report could be traced to a commit, and it only works in a build
 * that was given one: without `NEXT_PUBLIC_BUILD_SHA` the line traces to
 * nothing and reads as unfinished software to everybody except the person who
 * built it. Nothing else consumed them.
 *
 * <p>The build arguments are still wired up in docker-compose, so a version
 * line is a few lines away if it is ever wanted with a real commit behind it.
 */

export interface LegalLink {
  label: string;
  href: string;
}

export const LEGAL_LINKS: LegalLink[] = [
  { label: "Terms of Service", href: (process.env.NEXT_PUBLIC_TERMS_URL ?? "").trim() },
  { label: "Privacy Policy", href: (process.env.NEXT_PUBLIC_PRIVACY_URL ?? "").trim() },
].filter((link) => link.href.length > 0);
