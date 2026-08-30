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
 * Clerk wants the account holder to prove, again, that it is them.
 *
 * <h2>Why an operation that was allowed a minute ago is refused now</h2>
 *
 * <p>Clerk guards its sensitive user operations with <em>reverification</em>: a
 * session that has not proved a first factor in the last few minutes may read
 * anything but may not change the credential. Adding an address to the account
 * is one of the guarded ones, which is the whole point of it — changing the
 * address you sign in with is precisely what somebody who sat down at a
 * borrowed, still-signed-in laptop would do, and it is how an account is taken
 * rather than merely read.
 *
 * <p>Clerk's own `<UserProfile />` answers this by opening a dialog of its own.
 * Orion's profile is Orion's, so it asks in Orion's words — but the check is
 * Clerk's, it is right, and it is not something to switch off.
 *
 * <p>An `AccountActionError` on purpose, so callers that only know about that
 * one still show something sensible instead of falling through to a generic.
 */
export class ReverificationRequiredError extends AccountActionError {}

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
    try {
      await created.prepareVerification({ strategy: "email_code" });
    } catch (err) {
      /*
       * An address on the account with no code on the way is worse than no
       * address: the obvious next move is to try the same one again, and Clerk
       * answers that with "already taken" -- about an address nobody else has.
       */
      await created.destroy().catch(() => undefined);
      throw err;
    }
    pending.set(created.id, created);
    return { id: created.id, address };
  } catch (err) {
    if (isReverificationRequired(err)) {
      throw new ReverificationRequiredError(
        "Confirm your password before changing the address you sign in with.",
      );
    }
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

/**
 * Send the code again, to the address already added.
 *
 * <p>The one thing a screen that says "we sent you a code" has to be able to do
 * when nothing arrives. Mail is delayed, mail lands in spam, and — the case
 * this was written for — mail goes to a domain a letter away from the one that
 * was meant, where it is delivered perfectly and read by nobody.
 */
export async function resendEmailCode(handle: PendingEmail): Promise<void> {
  const created = pending.get(handle.id);
  if (!created) {
    throw new AccountActionError("That change has expired. Start again.");
  }
  try {
    await created.prepareVerification({ strategy: "email_code" });
  } catch (err) {
    throw new AccountActionError(clerkMessage(err, "That code could not be sent again."));
  }
}

/** Abandon a change: take the unverified address back off the account. */
export async function cancelEmailChange(handle: PendingEmail): Promise<void> {
  const created = pending.get(handle.id);
  pending.delete(handle.id);
  await created?.destroy().catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* Proving it is you, again                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Satisfy Clerk's reverification with the account's own password.
 *
 * <p>The password is the only first factor offered here, and that is not a
 * shortcut: the Change email button exists only for accounts Orion's own
 * sign-up made, and those are exactly the accounts Clerk holds a password for.
 * An account under Google owns none of these fields and never reaches this
 * code — see {@link identityPermissions}.
 *
 * <p>Nothing is stored. The password goes to Clerk, which is the only thing
 * that can check it, and this module keeps no copy — the same arrangement as
 * {@link changePassword}.
 */
export async function reverifyWithPassword(password: string): Promise<void> {
  const session = await requireSession();
  const start = session.__experimental_startVerification;
  const attempt = session.__experimental_attemptFirstFactorVerification;

  /*
   * Reverification is behind an experimental flag in this version of the SDK,
   * so it can be absent from the script that actually loaded. Signing in is
   * itself a first factor, so a fresh sign-in satisfies the check -- which
   * makes for a fallback that is a real instruction rather than an apology.
   */
  if (typeof start !== "function" || typeof attempt !== "function") {
    throw new AccountActionError(
      "Sign out and sign in again, then change the address within a few minutes.",
    );
  }

  try {
    const started = await start.call(session, { level: "firstFactor" });
    // Already satisfied. Somebody who signed in a moment ago lands here.
    if (started.status === "complete") return;

    const done = await attempt.call(session, { strategy: "password", password });
    if (done.status === "complete") return;

    if (done.status === "needs_second_factor") {
      // Orion draws no second-factor form, and pretending otherwise would be a
      // dialog that can only fail. Signing in again does the whole of it.
      throw new AccountActionError(
        "This account needs its second factor. Sign out and sign in again, then try once more.",
      );
    }
    throw new AccountActionError("That password is not right.");
  } catch (err) {
    if (err instanceof AccountActionError) throw err;
    throw new AccountActionError(clerkMessage(err, "That password is not right."));
  }
}

/**
 * Whether a refusal is Clerk asking for a fresh proof of identity.
 *
 * <p>The code is matched loosely and the sentence is matched as well. This is
 * an experimental feature in the SDK this app is pinned to, its error code has
 * moved once already, and the cost of missing it is the raw provider string —
 * "You need to provide additional verification to perform this operation" —
 * arriving in a dialog with no field to provide it in.
 */
function isReverificationRequired(err: unknown): boolean {
  const first = (err as { errors?: { code?: string; message?: string }[] })?.errors?.[0];
  if (!first) return false;
  if ((first.code ?? "").includes("reverification")) return true;
  return /additional verification/i.test(first.message ?? "");
}

async function requireUser() {
  const clerk = await loadClerk();
  const user = clerk.user;
  if (!user) throw new AccountActionError("You are not signed in.");
  return user;
}

async function requireSession() {
  const clerk = await loadClerk();
  const session = clerk.session;
  if (!session) throw new AccountActionError("You are not signed in.");
  return session;
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

/**
 * The reverification calls, as much of them as this module drives.
 *
 * <p>Both optional: they are `__experimental_` in the pinned SDK, so the script
 * that loads at runtime may not carry them. See {@link reverifyWithPassword}.
 */
interface ClerkSession {
  __experimental_startVerification?: (params: {
    level: string;
  }) => Promise<{ status: string }>;
  __experimental_attemptFirstFactorVerification?: (params: {
    strategy: string;
    password: string;
  }) => Promise<{ status: string }>;
}

interface ClerkLike {
  session?: ClerkSession | null;
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
