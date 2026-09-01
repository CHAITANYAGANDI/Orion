package com.reverie.security;

import com.reverie.common.ApiException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * One account, enforced.
 *
 * <h2>What this turns a promise into</h2>
 *
 * <p>{@code REVERIE_MAIL_SELF_ONLY} began as a declaration — "this deployment has
 * no users other than me" — made so that a solo deployment with no verified
 * mail domain could pass the production check honestly instead of having the
 * check deleted. A declaration is only as good as its truth, and this one stops
 * being true the moment a stranger signs up. Nothing announced that, and
 * nothing prevented it.
 *
 * <p>So the declaration is enforced. {@code REVERIE_MAIL_SELF_ONLY=true} requires
 * {@code REVERIE_MAIL_SELF_USER_ID}, and any other authenticated subject is
 * refused before an account exists for it. The claim the deployment check relies
 * on is therefore a property of the running system rather than an intention.
 *
 * <h2>Missing configuration fails closed, at startup</h2>
 *
 * <p>An earlier version of this class treated {@code self-only=true} with a
 * blank id as "enforce nothing", on the reasoning that an empty allow-list
 * refusing everybody would lock an operator out of their own deployment over a
 * missing variable. That reasoning was wrong, and dangerously so: it turned the
 * one setting whose entire job is to restrict access into a setting that
 * silently did the opposite of what it said. Somebody who sets
 * {@code SELF_ONLY=true} and mistypes the second variable name gets an
 * <em>open</em> deployment, and every signal — the log line, the settings, the
 * deployment check under a non-production profile — agrees that it is closed.
 *
 * <p>It now refuses to construct, which fails application startup with the
 * reason on it. That is the correct place for the failure: an unstartable
 * deployment is a bad ten minutes, an open one that believes it is closed is
 * the thing this class exists to prevent. Refusing at request time instead
 * would mean a running app returning 403 to its own operator with no
 * explanation anywhere.
 *
 * <p>This is not a burden on local development. Nobody has to configure
 * anything: leaving {@code REVERIE_MAIL_SELF_ONLY} unset — its default — asks for
 * no restriction and gets none. The exception is reachable only by explicitly
 * asking for a restriction and then not saying what it is.
 *
 * <h2>Why the gate is at provisioning and not at the sign-up page</h2>
 *
 * <p>Hiding the sign-up button is not access control. Clerk will happily create
 * an account for anybody who reaches its hosted flow, a token minted for that
 * account is perfectly valid, and Reverie would provision a local user for it on
 * the first request. The only place that cannot be walked around is the point
 * where Reverie decides a subject deserves a row — see
 * {@link com.reverie.service.UserService#provision}.
 *
 * <p>That point is also the only one that gets the second half right. Refusing
 * the request but inserting the user would leave a real account behind, with a
 * real id, that every later request could act as; refusing at provisioning
 * means <b>no row is written at all</b>, so a rejected stranger leaves nothing
 * to clean up.
 *
 * <h2>The identifier</h2>
 *
 * <p>The Clerk user id — the JWT {@code sub}, which is exactly what
 * {@code provision} is keyed on. Not the email address: an address can be
 * changed at the provider, is not unique across providers, and is the thing an
 * attacker would try to control. The subject is issued by Clerk, is stable for
 * the life of the account, and is the identifier the tenant boundary is already
 * built on.
 *
 * <p>In a development build the subject is whatever {@code X-Dev-User} says, and
 * this gate applies there too. That is not a security claim — dev mode has none
 * — it is so the behaviour can be exercised without a Clerk instance.
 */
@Component
public class SelfOnlyAccess {

    private static final Logger log = LoggerFactory.getLogger(SelfOnlyAccess.class);

    private final boolean enforced;
    private final String allowed;

    public SelfOnlyAccess(@Value("${reverie.mail.self-only:false}") boolean selfOnly,
                          @Value("${reverie.mail.self-user-id:}") String selfUserId) {
        this.enforced = selfOnly;
        this.allowed = selfUserId == null ? "" : selfUserId.trim();

        if (enforced && allowed.isEmpty()) {
            /*
             * Fails startup, deliberately, in every profile. The alternative --
             * booting and enforcing nothing -- makes the one setting whose job
             * is to restrict access silently do the opposite of what it says,
             * and a typo in the second variable name is all it takes.
             *
             * Not "return 403 to everybody" either: that is a running
             * application refusing its own operator with the reason nowhere.
             */
            throw new IllegalStateException(
                    "REVERIE_MAIL_SELF_ONLY is true but REVERIE_MAIL_SELF_USER_ID is blank. "
                            + "Self-only mode restricts this deployment to a single account, and "
                            + "it cannot do that without knowing which one -- so it refuses to "
                            + "start rather than run unrestricted while reporting that it is "
                            + "restricted. Set REVERIE_MAIL_SELF_USER_ID to your Clerk user id "
                            + "(it starts with `user_`, and is on your user in the Clerk "
                            + "dashboard), or unset REVERIE_MAIL_SELF_ONLY if you did not want "
                            + "the restriction.");
        }
        if (enforced) {
            log.warn("SELF-ONLY MODE: only the account {} may use this deployment. "
                    + "Any other sign-in is refused and no account is created for it.", allowed);
        }
    }

    /**
     * Whether the gate is doing anything.
     *
     * <p>Equal to the flag, and that is the invariant: a constructed instance
     * with {@code enforced} true always has an account to compare against,
     * because the alternative did not survive construction.
     */
    public boolean enforced() {
        return enforced;
    }

    /** Whether this subject may have an account here. */
    public boolean permits(String clerkUserId) {
        if (!enforced) {
            return true;
        }
        // Trimmed on both sides: the configured value was pasted out of a
        // dashboard, and a subject arriving with whitespace is not a different
        // person.
        return allowed.equals(clerkUserId == null ? "" : clerkUserId.trim());
    }

    /**
     * Refuse anybody who is not the one allowed account.
     *
     * <p>403 rather than 401: the caller proved who they are perfectly well, and
     * telling them their token is invalid would send them round a sign-in loop
     * that can never succeed. This is authorization, and it is final.
     *
     * <p>The refused subject is logged. It is an opaque provider id rather than
     * anything about a person, and it is the one fact an operator needs when
     * the answer turns out to be that they configured their own id wrongly —
     * which is by far the likeliest reason anybody ever sees this.
     */
    public void requireOrThrow(String clerkUserId) {
        if (permits(clerkUserId)) {
            return;
        }
        log.warn("Refused {}: this deployment is in self-only mode and allows {} only.",
                clerkUserId, allowed);
        throw ApiException.forbidden(
                "This deployment is private. It is configured for a single account.");
    }
}
