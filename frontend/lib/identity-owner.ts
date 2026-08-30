/**
 * Who owns your name and your password — and therefore where they can be
 * changed.
 *
 * <h2>The question this answers</h2>
 *
 * <p>Orion has two kinds of account and they are not the same underneath:
 *
 * <ul>
 *   <li><b>Signed up with Google.</b> The name and the picture are Google's,
 *       arriving through Clerk. There is no password — Google authenticates,
 *       and Clerk holds no credential of its own for this person.</li>
 *   <li><b>Signed up with an email and a password.</b> Clerk holds the
 *       credential, and the name and the password are the account holder's to
 *       change from here.</li>
 * </ul>
 *
 * <p>The old rule could not tell them apart. It asked one question — "is this
 * deployment using Clerk?" — and answered both cases the same way, so somebody
 * who signed in with Google got a Change password button that could only fail,
 * because there is no current password to give it.
 *
 * <h2>The address is not in here</h2>
 *
 * <p>It used to be, with a whole vocabulary about where a changed one had to go.
 * It is gone because nobody changes their address in Orion any more, whatever
 * kind of account they have — see lib/account-actions. The address is a display
 * on every screen that shows it, so there is nothing left to decide.
 *
 * <h2>Why an editable field that cannot save is worse than no field</h2>
 *
 * <p>A disabled input with a sentence beside it is understood in a second. A
 * form that accepts an edit and reverts it — which is what a Google name does,
 * because the next sign-in rewrites it — is the kind of bug people report as
 * data loss.
 *
 * <p>So this fails closed: an account whose credential cannot be identified is
 * treated as somebody else's, and the fields are locked rather than offered.
 */

/** Where the identity lives. */
export type IdentityOwner =
  /** Clerk, on Orion's behalf: an email and password account made here. */
  | "orion"
  /** An identity provider — Google today. */
  | "external"
  /** No provider at all: a dev build, identified by a header. */
  | "dev";

export interface Credential {
  /** `authStore.mode`: "clerk" or "dev". */
  mode: string;
  /**
   * The connected OAuth provider, lower-case and unprefixed — "google" — or
   * "" when the account has none.
   */
  provider: string;
  /** Whether Clerk holds a password for this account. */
  hasPassword: boolean;
}

export interface IdentityPermissions {
  owner: IdentityOwner;
  /** Orion's own `display_name` column. */
  name: boolean;
  /*
   * There is no `email` here, and its absence is the answer rather than an
   * omission: the address on an Orion account is fixed once it is made, for
   * every kind of account. See lib/account-actions for why.
   */
  password: boolean;
  /**
   * What to call whoever owns it, in a sentence: "Google", "your sign-in
   * provider". Empty when Orion owns it and there is nothing to name.
   */
  ownerLabel: string;
}

/** Providers whose name is worth printing. Anything else gets the generic. */
const NAMES: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  apple: "Apple",
};

export function identityOwner({ mode, provider, hasPassword }: Credential): IdentityOwner {
  if (mode !== "clerk") return "dev";
  /*
   * The provider wins over the password, and that order is deliberate. An
   * account that signed up with Google and later set a password still has
   * Google as the source of its name and address, and offering to edit them
   * here would be offering to edit a copy.
   */
  if (provider) return "external";
  if (hasPassword) return "orion";
  /*
   * Signed in under Clerk with neither a password nor a connection. Nothing
   * here knows what to do with that, so nothing here offers to change it —
   * every alternative ends in a form that fails on submit.
   */
  return "external";
}

export function identityPermissions(credential: Credential): IdentityPermissions {
  const owner = identityOwner(credential);
  const label = NAMES[credential.provider] || "your sign-in provider";

  switch (owner) {
    case "orion":
      // Clerk holds the credential on Orion's behalf, and this is the account
      // holder. All three are theirs.
      return { owner, name: true, password: true, ownerLabel: "" };
    case "dev":
      // No provider and no credential: the name and address are ordinary
      // columns, and there is no password in existence to rotate.
      return { owner, name: true, password: false, ownerLabel: "" };
    case "external":
    default:
      return { owner, name: false, password: false, ownerLabel: label };
  }
}

/**
 * Clerk spells a connection `oauth_google` in some places and `google` in
 * others. One spelling reaches the rest of the app.
 */
export function normalizeProvider(raw: string | null | undefined): string {
  // Lower-cased first, then stripped. The other order leaves `OAuth_Google`
  // as `oauth_google`, which matches no name in the table and would tell
  // somebody their account is held by "your sign-in provider".
  return (raw || "").toLowerCase().replace(/^oauth_/, "");
}
