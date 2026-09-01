package com.reverie.security;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The tenant context that arms row-level security.
 *
 * <p>Every test here is about leakage. Request threads are pooled and reused,
 * so a tenant left behind is inherited by whoever the thread serves next — and
 * a system flag left behind hands that request unrestricted access to every
 * tenant's data. Those are the failure modes worth pinning; the happy path is
 * one line.
 */
class TenantContextTest {

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @Test
    @DisplayName("with nothing set, the tenant is empty — which matches no rows")
    void defaultsToEmptyNotNull() {
        // "" rather than null is deliberate: it is bound as a query parameter,
        // and an empty string satisfies no policy, so an unconfigured thread
        // sees nothing instead of erroring or seeing everything.
        assertThat(TenantContext.currentUserId()).isEmpty();
        assertThat(TenantContext.isSystem()).isFalse();
    }

    @Test
    @DisplayName("the tenant is readable once set")
    void setAndRead() {
        TenantContext.setUserId("usr_1");
        assertThat(TenantContext.currentUserId()).isEqualTo("usr_1");
    }

    @Test
    @DisplayName("clear removes both the tenant and the system flag")
    void clearRemovesEverything() {
        TenantContext.setUserId("usr_1");
        TenantContext.runAsSystem(() -> { });

        TenantContext.clear();

        assertThat(TenantContext.currentUserId()).isEmpty();
        assertThat(TenantContext.isSystem()).isFalse();
    }

    // --- system context ------------------------------------------------------ //

    @Test
    @DisplayName("system context applies only inside the block")
    void systemIsScoped() {
        assertThat(TenantContext.isSystem()).isFalse();
        TenantContext.runAsSystem(() -> assertThat(TenantContext.isSystem()).isTrue());
        assertThat(TenantContext.isSystem()).isFalse();
    }

    @Test
    @DisplayName("an exception cannot leave a thread stuck in system context")
    void systemIsRestoredAfterFailure() {
        // The dangerous case: a thread that stays privileged serves the next
        // request — a different user — with access to everyone's data.
        assertThatThrownBy(() -> TenantContext.runAsSystem(() -> {
            throw new IllegalStateException("boom");
        })).isInstanceOf(IllegalStateException.class);

        assertThat(TenantContext.isSystem()).isFalse();
    }

    @Test
    @DisplayName("nested system blocks restore the outer state, not the default")
    void systemNestsCorrectly() {
        TenantContext.runAsSystem(() -> {
            TenantContext.runAsSystem(() -> { });
            // The inner block must not have cancelled the outer one — the outer
            // work still has queries to run.
            assertThat(TenantContext.isSystem()).isTrue();
        });
        assertThat(TenantContext.isSystem()).isFalse();
    }

    @Test
    @DisplayName("the callable form returns its value and restores state")
    void callableFormWorks() throws Exception {
        String result = TenantContext.asSystem(() -> "provisioned");
        assertThat(result).isEqualTo("provisioned");
        assertThat(TenantContext.isSystem()).isFalse();
    }

    @Test
    @DisplayName("a checked exception propagates rather than being swallowed")
    void callableFormPropagates() {
        assertThatThrownBy(() -> TenantContext.asSystem(() -> {
            throw new Exception("provisioning failed");
        })).hasMessage("provisioning failed");

        assertThat(TenantContext.isSystem()).isFalse();
    }

    // --- thread confinement --------------------------------------------------- //

    @Test
    @DisplayName("one thread's tenant is invisible to another")
    void tenantDoesNotCrossThreads() throws Exception {
        TenantContext.setUserId("usr_main");
        AtomicReference<String> seen = new AtomicReference<>("unset");

        Thread other = new Thread(() -> seen.set(TenantContext.currentUserId()));
        other.start();
        other.join();

        // Async work therefore has to set its own tenant, which is why the
        // memory and recap listeners do so from the event.
        assertThat(seen.get()).isEmpty();
        assertThat(TenantContext.currentUserId()).isEqualTo("usr_main");
    }

    @Test
    @DisplayName("a reused thread does not inherit the previous tenant once cleared")
    void reusedThreadStartsClean() throws Exception {
        // Simulates a pooled request thread serving two different users.
        AtomicReference<String> secondRequestSaw = new AtomicReference<>("unset");
        CountDownLatch done = new CountDownLatch(1);

        Thread pooled = new Thread(() -> {
            TenantContext.setUserId("usr_first");
            TenantContext.clear();               // what TenantFilter guarantees

            secondRequestSaw.set(TenantContext.currentUserId());
            done.countDown();
        });
        pooled.start();
        assertThat(done.await(5, TimeUnit.SECONDS)).isTrue();

        assertThat(secondRequestSaw.get()).isEmpty();
    }
}
