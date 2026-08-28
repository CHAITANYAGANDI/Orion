package com.orion.config;

import com.orion.security.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Which database role a piece of work connects as.
 *
 * <p>The routing key decides whether row-level security applies at all, so the
 * only interesting question is what happens when nobody has said anything: the
 * answer has to be the restricted pool. Defaulting the other way would mean a
 * forgotten declaration silently grants access to every tenant.
 */
class TenantRoutingDataSourceTest {

    private final TestableRouting routing = new TestableRouting();

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @Test
    @DisplayName("an ordinary request routes to the restricted pool")
    void tenantByDefault() {
        TenantContext.setUserId("usr_alice");
        assertThat(routing.key()).isEqualTo(TenantRoutingDataSource.Route.TENANT);
    }

    @Test
    @DisplayName("with nothing set at all it still routes to the restricted pool")
    void restrictedWhenNothingIsSet() {
        // The failure that matters: a path that forgets to declare itself must
        // read nothing, not everything.
        assertThat(routing.key()).isEqualTo(TenantRoutingDataSource.Route.TENANT);
    }

    @Test
    @DisplayName("declared system work routes to the privileged pool")
    void systemWhenDeclared() {
        TenantContext.runAsSystem(() ->
                assertThat(routing.key()).isEqualTo(TenantRoutingDataSource.Route.SYSTEM));
    }

    @Test
    @DisplayName("routing reverts as soon as the system block ends")
    void revertsAfterSystemBlock() {
        TenantContext.runAsSystem(() -> { });
        assertThat(routing.key()).isEqualTo(TenantRoutingDataSource.Route.TENANT);
    }

    @Test
    @DisplayName("a failure inside system work cannot leave routing privileged")
    void revertsAfterFailure() {
        try {
            TenantContext.runAsSystem(() -> {
                throw new IllegalStateException("boom");
            });
        } catch (IllegalStateException expected) {
            // The next request on this pooled thread must not inherit BYPASSRLS.
        }
        assertThat(routing.key()).isEqualTo(TenantRoutingDataSource.Route.TENANT);
    }

    /** Exposes the protected lookup key for assertion. */
    private static final class TestableRouting extends TenantRoutingDataSource {
        Object key() {
            return determineCurrentLookupKey();
        }
    }
}
