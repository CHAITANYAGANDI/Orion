package com.reverie.repository;

import com.reverie.ReverieApplication;
import com.reverie.service.UserService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The race, run for real.
 *
 * <h2>What is being proved</h2>
 *
 * <p>{@code UserProvisioningTest} checks the shape of the calls with a mock,
 * which is worth having and proves nothing about concurrency: a mock cannot
 * refuse a second insert, so it cannot be the thing that shows the second
 * insert is refused. The claim here is about Postgres — that
 * {@code ON CONFLICT (clerk_user_id) DO NOTHING} makes first-login creation
 * atomic — and it can only be tested against Postgres.
 *
 * <p>Eight threads released together against one brand-new Clerk subject, which
 * is what a browser does on first load and what produced four
 * {@code users_clerk_user_id_key} violations in the same millisecond on the
 * deployment this fixes.
 *
 * <h2>Why a barrier rather than just submitting eight tasks</h2>
 *
 * <p>Submitting them lets the pool start the first one and finish it before the
 * eighth is scheduled, and a race that does not happen passes trivially. The
 * barrier holds every thread until all eight are ready, so they enter
 * {@code provision} together and the window this is about is actually open.
 *
 * <p><strong>Needs a PostgreSQL, and skips without one.</strong> Same switch as
 * the other integration tests here.
 */
@SpringBootTest(
        classes = ReverieApplication.class,
        webEnvironment = SpringBootTest.WebEnvironment.NONE)
@EnabledIfEnvironmentVariable(named = "REVERIE_IT_DB_URL", matches = ".+",
        disabledReason = "needs a PostgreSQL: the claim is about ON CONFLICT, not about Java")
class UserProvisioningConcurrencyTest {

    private static final int THREADS = 8;

    @DynamicPropertySource
    static void realDatabaseAndNoBroker(DynamicPropertyRegistry registry) {
        String url = System.getenv("REVERIE_IT_DB_URL");
        String owner = env("REVERIE_IT_DB_OWNER_USER", "REVERIE_IT_DB_USER");
        String password = env("REVERIE_IT_DB_OWNER_PASSWORD", "REVERIE_IT_DB_PASSWORD");

        registry.add("spring.datasource.url", () -> url);
        registry.add("spring.datasource.username", () -> owner);
        registry.add("spring.datasource.password", () -> password);
        registry.add("spring.flyway.url", () -> url);
        registry.add("spring.flyway.user", () -> owner);
        registry.add("spring.flyway.password", () -> password);
        registry.add("reverie.datasource.system.username", () -> owner);
        registry.add("reverie.datasource.system.password", () -> password);

        // Eight threads want eight connections at once, and Hikari's default
        // maximum of ten accommodates that. Deliberately not set here:
        // TenantDataSourceConfig builds its pools with DataSourceBuilder rather
        // than from `spring.datasource.hikari.*`, so a property would look like
        // it sized the pool and would not.
        //
        // No TenantContext is established, so these calls take the tenant pool.
        // Production provisions under system context and a pool of five, which
        // still leaves five callers inside provision() together -- fewer
        // threads, same race, same statement deciding it.

        // Nowhere, quickly. This is about the database.
        registry.add("spring.kafka.bootstrap-servers", () -> "localhost:1");
        registry.add("spring.kafka.security.protocol", () -> "PLAINTEXT");
        registry.add("spring.kafka.properties.default.api.timeout.ms", () -> "1000");
        registry.add("spring.kafka.properties.request.timeout.ms", () -> "1000");
        registry.add("spring.kafka.admin.fail-fast", () -> "false");
        registry.add("spring.kafka.admin.auto-create", () -> "false");
        registry.add("reverie.outbox.poll-ms", () -> "3600000");
    }

    private static String env(String preferred, String fallback) {
        String value = System.getenv(preferred);
        if (value == null || value.isBlank()) {
            value = System.getenv(fallback);
        }
        return value == null ? "" : value;
    }

    @Autowired private UserService userService;

    private final String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    private final String subject = "user_it_" + suffix;
    private final String email = "race_" + suffix + "@example.com";

    @AfterEach
    void removeTheAccount() throws Exception {
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                     "DELETE FROM users WHERE clerk_user_id = ?")) {
            ps.setString(1, subject);
            ps.executeUpdate();
        }
    }

    @Test
    @DisplayName("eight simultaneous first logins produce one account and no failures")
    void theRaceIsSurvived() throws Exception {
        List<String> ids = provisionConcurrently();

        // 1. Nobody failed. A thrown DataIntegrityViolationException would have
        //    surfaced out of Future.get() above and failed the test there; this
        //    says every caller came back with something.
        assertThat(ids).hasSize(THREADS).doesNotContainNull();

        // 2. They all got the SAME account. This is the one that matters most:
        //    a loser returning its own generated id would hand a request a user
        //    id with no row behind it.
        assertThat(ids).containsOnly(ids.get(0));

        // 3. And there is exactly one row, which is the constraint's account of
        //    the same fact.
        assertThat(rowsForSubject()).isEqualTo(1);
        assertThat(ids.get(0)).isEqualTo(persistedId());
    }

    @Test
    @DisplayName("the row it creates is a complete account, not a stub")
    void defaultsSurviveTheNativeInsert() throws Exception {
        /*
         * The native insert names only id, clerk_user_id, email and plan. Every
         * other column a new account needs has to come from a column default,
         * and this is the check that those defaults are really there rather
         * than living only as field initialisers on UserEntity -- which is
         * where they would have been applied before this change.
         */
        provisionConcurrently();

        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement("""
                     SELECT email, plan, created_at, muted_notifications,
                            retention_warning_email,
                            retention_applied_email, task_reminder_email,
                            notes_ready_email, allowance_email
                       FROM users WHERE clerk_user_id = ?
                     """)) {
            ps.setString(1, subject);
            try (ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getString("email")).isEqualTo(email);
                assertThat(rs.getString("plan")).isEqualTo("FREE");
                assertThat(rs.getTimestamp("created_at")).isNotNull();
                assertThat(rs.getString("muted_notifications")).isEqualTo("[]");
                // All five email switches start off. V64 is explicit that this
                // is the default and that two messages ignore it.
                assertThat(rs.getBoolean("retention_warning_email")).isFalse();
                assertThat(rs.getBoolean("retention_applied_email")).isFalse();
                assertThat(rs.getBoolean("task_reminder_email")).isFalse();
                assertThat(rs.getBoolean("notes_ready_email")).isFalse();
                assertThat(rs.getBoolean("allowance_email")).isFalse();
            }
        }
    }

    @Test
    @DisplayName("provisioning again afterwards is the cheap path and changes nothing")
    void secondTimeIsIdempotent() throws Exception {
        String first = provisionConcurrently().get(0);

        String again = userService.provision(subject, email);

        assertThat(again).isEqualTo(first);
        assertThat(rowsForSubject()).isEqualTo(1);
    }

    /** Eight threads into {@code provision}, released together. */
    private List<String> provisionConcurrently() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(THREADS);
        CyclicBarrier gate = new CyclicBarrier(THREADS);
        try {
            List<Callable<String>> calls = new ArrayList<>();
            for (int i = 0; i < THREADS; i++) {
                calls.add(() -> {
                    gate.await(20, TimeUnit.SECONDS);
                    return userService.provision(subject, email);
                });
            }
            List<Future<String>> futures = pool.invokeAll(calls, 60, TimeUnit.SECONDS);

            List<String> ids = new ArrayList<>();
            for (Future<String> f : futures) {
                // Any uniqueness violation that escaped provision() arrives
                // here as an ExecutionException and fails the test, which is
                // exactly the assertion "zero escape" needs.
                ids.add(f.get());
            }
            return ids;
        } finally {
            pool.shutdownNow();
        }
    }

    private int rowsForSubject() throws Exception {
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                     "SELECT COUNT(*) FROM users WHERE clerk_user_id = ?")) {
            ps.setString(1, subject);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getInt(1);
            }
        }
    }

    private String persistedId() throws Exception {
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                     "SELECT id FROM users WHERE clerk_user_id = ?")) {
            ps.setString(1, subject);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getString(1);
            }
        }
    }

    private static Connection connect() throws Exception {
        return DriverManager.getConnection(
                System.getenv("REVERIE_IT_DB_URL"),
                env("REVERIE_IT_DB_OWNER_USER", "REVERIE_IT_DB_USER"),
                env("REVERIE_IT_DB_OWNER_PASSWORD", "REVERIE_IT_DB_PASSWORD"));
    }
}
