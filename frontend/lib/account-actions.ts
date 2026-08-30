/**
 * Changing the two things Orion does not own.
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
 * <p><b>Deployment, not account.</b> This answers "is there a provider here at
 * all" and nothing more: a development session is identified by a header, has
 * no credential, and therefore has nothing to rotate.
 *
 * <p>It is not sufficient on its own and is no longer used on its own. An
 * account signed in through Google is under Clerk and still has no password —
 * `updatePassword` needs a current one and there is none — so whether to offer
 * the dialog is {@link identityPermissions}' question. This stays because the
 * dev/clerk half of that answer belongs here.
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

/* -------------------------------------------------------------------------- */
/* Changing the address                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A new address, created and awaiting its code.
 *
 * <p>Opaque on purpose. The caller holds it between the two steps of the
 * dialog and hands it back; nothing outside this module needs to know it is a
 * Clerk resource.
 */
export interface PendingEmail {
  readonly id: string;
  readonly address: string;
}

/** The resource, kept here so the handle above can stay opaque. */
const pending = new Map<string, ClerkEmailAddress>();

/**
 * Add the new address to the account and send it a code.
 *
 * <p><b>Why this does not go through Orion's API.</b> Under an identity
 * provider the address is not a profile field, it is the credential — the thing
 * sign-in matches on — so changing it is Clerk's operation, and Orion's column
 * is a copy that follows. `UserService.cleanAccountEmail` refuses an address
 * edit under Clerk for exactly this reason, and it is right to.
 *
 * <p>Nothing changes until the code comes back. The old address stays the
 * primary one throughout, so an address typed wrong here cannot lock somebody
 * out of their account.
 */
export async function startEmailChange(address: string): Promise<PendingEmail> {
  const user = await requireUser();
  try {
    const created = await user.createEmailAddress({ email: address });
    await created.prepareVerification({ strategy: "email_code" });
    pending.set(created.id, created);
    return { id: created.id, address };
  } catch (err) {
    throw new AccountActionError(clerkMessage(err, "That address could not be added."));
  }
}

/**
 * Prove the new address, make it the one that signs in, and drop the old one.
 *
 * <p>The order matters and is not interchangeable. Verify, then promote, then
 * remove: promoting an unverified address would be trusting a typo, and
 * removing the old one before the new is primary would leave the account with
 * no address at all for as long as the next call takes.
 */
export async function confirmEmailChange(handle: PendingEmail, code: string): Promise<void> {
  const user = await requireUser();
  const created = pending.get(handle.id);
  if (!created) {
    throw new AccountActionError("That change has expired. Start again.");
  }
  try {
    await created.attemptVerification({ code });
    const previous = user.primaryEmailAddressId;
    await user.update({ primaryEmailAddressId: created.id });
    if (previous && previous !== created.id) {
      // Best effort. The change has already happened; an address left behind is
      // untidy rather than broken, and reporting it as a failure would be a lie
      // about what just took effect.
      await user.emailAddresses
        ?.find((address) => address.id === previous)
        ?.destroy()
        .catch(() => undefined);
    }
    pending.delete(handle.id);
  } catch (err) {
    throw new AccountActionError(clerkMessage(err, "That code did not confirm the address."));
  }
}

/** Abandon a change: take the unverified address back off the account. */
export async function cancelEmailChange(handle: PendingEmail): Promise<void> {
  const created = pending.get(handle.id);
  pending.delete(handle.id);
  await created?.destroy().catch(() => undefined);
}

async function requireUser() {
  const clerk = await loadClerk();
  const user = clerk.user;
  if (!user) throw new AccountActionError("You are not signed in.");
  return user;
}

/**
 * Clerk's own words, where it gave any.
 *
 * <p>Its errors are the useful ones — "that password has appeared in a data
 * breach", "incorrect password" — and replacing them with a generic failure
 * would throw away the only part of this a person can act on.
 */
function clerkMessage(
  err: unknown,
  fallback = "That password could not be changed. Check the current one and try again.",
): string {
  const errors = (err as { errors?: { longMessage?: string; message?: string }[] })?.errors;
  const first = errors?.[0];
  const said = first?.longMessage || first?.message;
  return said || fallback;
}

/** One address on the account, as much of it as this module touches. */
interface ClerkEmailAddress {
  id: string;
  prepareVerification: (opts: { strategy: string }) => Promise<unknown>;
  attemptVerification: (opts: { code: string }) => Promise<unknown>;
  destroy: () => Promise<unknown>;
}

interface ClerkLike {
  user?: {
    updatePassword: (opts: {
      currentPassword: string;
      newPassword: string;
      signOutOfOtherSessions?: boolean;
    }) => Promise<unknown>;
    createEmailAddress: (opts: { email: string }) => Promise<ClerkEmailAddress>;
    update: (opts: { primaryEmailAddressId: string }) => Promise<unknown>;
    primaryEmailAddressId?: string | null;
    emailAddresses?: ClerkEmailAddress[];
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
