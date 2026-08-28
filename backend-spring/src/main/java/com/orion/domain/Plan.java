package com.orion.domain;

/**
 * What an account's tier is called.
 *
 * <p>It used to carry the limits too — {@code FREE(5, 60)}, {@code PRO(50, 600)},
 * {@code PREMIUM} unlimited — and it no longer carries any. The allowance is one
 * pair of numbers for every account, in
 * {@link com.orion.service.UsageLimitService}: 100 transcribed minutes and 3
 * imports, for the life of the account.
 *
 * <p>Three ceilings were three answers to a question with one. Orion has a
 * single tier and nothing to upgrade to, so PRO and PREMIUM were never sold —
 * they are rows left in the users table by an earlier build. Their effect was
 * that the account doing the most work was the one no limit applied to, which
 * is the opposite of what a rate limit is for.
 *
 * <p>Kept as an enum because the name is still read: it is stored on the user,
 * shown at the foot of the rail, and an unknown value has to degrade to
 * something rather than throw.
 */
public enum Plan {
    FREE,
    PRO,
    PREMIUM;

    public static Plan fromString(String value) {
        if (value == null) {
            return FREE;
        }
        try {
            return Plan.valueOf(value.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            return FREE;
        }
    }
}
