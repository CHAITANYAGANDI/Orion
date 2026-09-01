package com.reverie.security;

/**
 * What this request's credential says about how the caller signed in.
 *
 * <p>Reverie does not authenticate anybody. There is no password column, no
 * login form and no session to establish — the filter verifies a token Clerk
 * issued, or in dev trusts a header. That makes a second factor something that
 * happened somewhere else, and the only honest thing this application can do
 * about it is report what the credential asserts and say where it is configured.
 *
 * <p>{@code secondFactor} is therefore three-valued rather than a boolean.
 * {@code TRUE} and {@code FALSE} are claims the token actually made; {@code
 * null} means it made none, which is the common case because Clerk's default
 * session token carries neither — it has to be added to the JWT template, the
 * same as the email claim. Collapsing null into false would be the dangerous
 * direction: a settings page reporting "two-factor authentication is off" to
 * somebody who has it switched on at their provider teaches them the display is
 * wrong, and after that it cannot warn them about anything.
 *
 * @param authMode     {@code clerk} or {@code dev}
 * @param secondFactor what the token asserted, or null if it said nothing
 */
public record SignInSecurity(String authMode, Boolean secondFactor) {

    public static final String CLERK = "clerk";
    public static final String DEV = "dev";

    /** A dev session: no provider, no sign-in, and therefore no factors at all. */
    public static SignInSecurity dev() {
        return new SignInSecurity(DEV, null);
    }

    /** Whether sign-in is somebody else's system, which is where 2FA is set up. */
    public boolean managedExternally() {
        return CLERK.equalsIgnoreCase(authMode);
    }
}
