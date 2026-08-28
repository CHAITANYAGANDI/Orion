/**
 * What is running, and the documents that govern it.
 *
 * Both come from the environment at build time, and both are absent rather than
 * invented when nothing supplied them. A version line is only worth having if a
 * bug report can be traced to a commit with it, so a container built without a
 * commit says `dev` — which is true — rather than showing a hash that resolves
 * to nothing.
 *
 * The legal links are the same principle with more at stake. Orion ships no
 * terms of service and no privacy policy of its own; they are documents somebody
 * has to write and be bound by, not strings a UI can supply. Set
 * `NEXT_PUBLIC_TERMS_URL` and `NEXT_PUBLIC_PRIVACY_URL` and the footer links to
 * them; leave them unset and the sentence does not appear at all.
 */

/** Set by the Dockerfile from `git rev-parse HEAD`, or absent locally. */
const COMMIT = (process.env.NEXT_PUBLIC_BUILD_SHA ?? "").trim();

/** Set from package.json at build time. */
const VERSION = (process.env.NEXT_PUBLIC_APP_VERSION ?? "").trim();

export const BUILD_COMMIT = COMMIT || "dev";
export const BUILD_VERSION = VERSION || "0.0.0";

/** "Version 0.1.0 — 622ff64" — short-form commit, because nobody reads forty. */
export const BUILD_LINE = `Version ${BUILD_VERSION} — ${
  COMMIT ? COMMIT.slice(0, 7) : "dev build"
}`;

export interface LegalLink {
  label: string;
  href: string;
}

export const LEGAL_LINKS: LegalLink[] = [
  { label: "Terms of Service", href: (process.env.NEXT_PUBLIC_TERMS_URL ?? "").trim() },
  { label: "Privacy Policy", href: (process.env.NEXT_PUBLIC_PRIVACY_URL ?? "").trim() },
].filter((link) => link.href.length > 0);
