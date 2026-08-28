package com.orion.config;

import com.orion.security.TenantContext;
import org.springframework.jdbc.datasource.lookup.AbstractRoutingDataSource;

/**
 * Chooses which database role a request's connections come from.
 *
 * <p>System work — worker callbacks, the outbox relay, Stripe webhooks, public
 * provisioning during authentication — connects as a role holding
 * BYPASSRLS. Everything else connects as a role that does not have it.
 *
 * <p>This is what makes the exemption unforgeable. When it was a session
 * setting the policies consulted, any statement could switch it on, so SQL
 * injection escaped row-level security entirely. A role attribute cannot be
 * granted by a statement: an injected query running on an app connection is
 * confined to whatever tenant that connection is stamped with, because there
 * is no SQL that will lift the restriction.
 *
 * <p>The routing key is read at connection checkout, so it reflects
 * {@link TenantContext} at the moment the transaction opens — which is why
 * system context has to be established before entering a
 * {@code @Transactional} method rather than inside one.
 */
public class TenantRoutingDataSource extends AbstractRoutingDataSource {

    /** Keys for the two pools. */
    public enum Route {
        /** Unprivileged: row-level security applies. The default. */
        TENANT,
        /** BYPASSRLS: the few paths that legitimately have no tenant. */
        SYSTEM
    }

    @Override
    protected Object determineCurrentLookupKey() {
        // Defaults to TENANT, so a path that forgets to declare itself gets the
        // restricted pool and reads nothing — rather than silently getting the
        // privileged one and reading everything.
        return TenantContext.isSystem() ? Route.SYSTEM : Route.TENANT;
    }
}
