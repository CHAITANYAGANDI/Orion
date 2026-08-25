/**
 * Changing the two things Recallix does not own.
 *
 * <p>Sign-in belongs to Clerk: there is no password column, no login form and
 * no session to establish here. So a password change is a call to the provider,
 * and this module is the whole of the seam between the profile dialog and it.
 *
 * <p>The Clerk SDK is imported dynamically for the same reason
 * `lib/clerk-auth.tsx` is: a development build must run with no Clerk key, and
 * a static import would pull the provider into every bundle and fail at boot
 * without one.
 */

export class AccountActionError extends Error {}

/**
 * Whether this deployment can change a password at all.
 *
 * <p>A development session is identified by a header. It has no provider, no
 * credential and therefore nothing to rotate — the honest answer there is that
 * there is no password, not a form that fails on submit.
 */
export function canChangePassword(mode: string): boolean {
  return mode === "clerk";
}

/**
 * Ask the provider to change the password.
 *
 * <p>The current one is sent rather than checked here: only the provider can
 * verify it, and it is what stops somebody changing the password on a borrowed
 * laptop that is still signed in.
 *
 * <p>Other sessions are signed out. Someone changing a password usually means
 * "I think somebody else has this", and leaving the sessions they are worried
 * about alive would defeat the whole exercise.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const clerk = await loadClerk();
  const user = clerk.user;
  if (!user) {
    throw new AccountActionError("You are not signed in.");
  }
  try {
    await user.updatePassword({
      currentPassword,
      newPassword,
      signOutOfOtherSessions: true,
    });
  } catch (err) {
    throw new AccountActionError(clerkMessage(err));
  }
}

/**
 * Clerk's own words, where it gave any.
 *
 * <p>Its errors are the useful ones — "that password has appeared in a data
 * breach", "incorrect password" — and replacing them with a generic failure
 * would throw away the only part of this a person can act on.
 */
function clerkMessage(err: unknown): string {
  const errors = (err as { errors?: { longMessage?: string; message?: string }[] })?.errors;
  const first = errors?.[0];
  const said = first?.longMessage || first?.message;
  return said || "That password could not be changed. Check the current one and try again.";
}

interface ClerkLike {
  user?: {
    updatePassword: (opts: {
      currentPassword: string;
      newPassword: string;
      signOutOfOtherSessions?: boolean;
    }) => Promise<unknown>;
  } | null;
}

/**
 * The live Clerk instance, from the global the SDK installs.
 *
 * <p>Read off `window` rather than through a React hook because this is called
 * from a submit handler, not during render, and adding `useUser` to the profile
 * dialog would make that component impossible to render in a dev build.
 */
async function loadClerk(): Promise<ClerkLike> {
  const clerk = (globalThis as { Clerk?: ClerkLike }).Clerk;
  if (!clerk) {
    throw new AccountActionError(
      "Sign-in is not available in this build, so there is no password to change.",
    );
  }
  return clerk;
}
