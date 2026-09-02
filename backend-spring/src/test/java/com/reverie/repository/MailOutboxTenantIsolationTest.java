package com.reverie.repository;

import com.reverie.ReverieApplication;
import com.reverie.security.TenantContext;
import com.reverie.service.PrivacyService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.SpyBean;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Who may write to {@code mail_outbox}, and what closing an account commits.
 *
 * <p><strong>Needs a PostgreSQL, and skips without one.</strong> Every claim
 * here is about row-level security, which has no in-memory stand-in.
 */
@SpringBootTest(
        classes = ReverieApplication.class,
        webEnvironment = SpringBootTest.WebEnvironment.NONE)
@EnabledIfEnvironmentVariable(named = "REVERIE_IT_DB_URL", matches = ".+",
        disabledReason = "needs a PostgreSQL: the claims are about RLS policies")
class MailOutboxTenantIsolationTest {

    @DynamicPropertySource
    static void realDatabaseAndNoBroker(DynamicPropertyRegistry registry) {
        String url = System.getenv("REVERIE_IT_DB_URL");
        // The APP role deliberately, not the owner: RLS is what is on trial and
        // the owner would bypass the very thing being tested.
        String app = env("REVERIE_IT_APP_USER", "REVERIE_IT_DB_USER");
        String appPassword = env("REVERIE_IT_APP_PASSWORD", "REVERIE_IT_DB_PASSWORD");
        String owner = env("REVERIE_IT_DB_OWNER_USER", "REVERIE_IT_DB_USER");
        String ownerPassword = env("REVERIE_IT_DB_OWNER_PASSWORD", "REVERIE_IT_DB_PASSWORD");
        String sys = env("REVERIE_IT_DB_USER", "REVERIE_IT_DB_OWNER_USER");
        String sysPassword = env("REVERIE_IT_DB_PASSWORD", "REVERIE_IT_DB_OWNER_PASSWORD");

        registry.add("spring.datasource.url", () -> url);
        registry.add("spring.datasource.username", () -> app);
        registry.add("spring.datasource.password", () -> appPassword);
        registry.add("reverie.datasource.system.username", () -> sys);
        registry.add("reverie.datasource.system.password", () -> sysPassword);
        registry.add("spring.flyway.url", () -> url);
        registry.add("spring.flyway.user", () -> owner);
        registry.add("spring.flyway.password", () -> ownerPassword);

        registry.add("spring.kafka.bootstrap-servers", () -> "localhost:1");
        registry.add("spring.kafka.security.protocol", () -> "PLAINTEXT");
        registry.add("spring.kafka.properties.default.api.timeout.ms", () -> "1000");
        registry.add("spring.kafka.properties.request.timeout.ms", () -> "1000");
        registry.add("spring.kafka.admin.fail-fast", () -> "false");
        registry.add("spring.kafka.admin.auto-create", () -> "false");
        registry.add("reverie.outbox.poll-ms", () -> "3600000");
        registry.add("reverie.mail.poll-ms", () -> "3600000");
    }

    private static String env(String preferred, String fallback) {
        String value = System.getenv(preferred);
        if (value == null || value.isBlank()) {
            value = System.getenv(fallback);
        }
        return value == null ? "" : value;
    }

    @Autowired private MailOutboxRepository outbox;
    @Autowired private PrivacyService privacy;
    @Autowired private PlatformTransactionManager txManager;
    @SpyBean private MailOutboxRepository outboxSpy;

    private final String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    private final String tenantA = "usr_a_" + suffix;
    private final String tenantB = "usr_b_" + suffix;

    @BeforeEach
    void twoAccounts() throws Exception {
        try (Connection c = owner()) {
            insertUser(c, tenantA, "a_" + suffix);
            insertUser(c, tenantB, "b_" + suffix);
        }
    }

    @AfterEach
    void cleanUp() throws Exception {
        TenantContext.clear();
        Mockito.reset(outboxSpy);
        try (Connection c = owner()) {
            exec(c, "DELETE FROM mail_outbox WHERE user_id IN (?, ?)", tenantA, tenantB);
            exec(c, "DELETE FROM users WHERE id IN (?, ?)", tenantA, tenantB);
        }
    }

    // ---------------------------------------------------------------- policy

    @Nested
    @DisplayName("what the app role may write")
    class Writing {

        @Test
        @DisplayName("a tenant may enqueue its own mail")
        void ownMailIsAllowed() {
            asTenant(tenantA, () -> outbox.enqueue(
                    "ml_" + suffix + "_own", "k_own_" + suffix, "a@example.com",
                    "s", "t", "<p>t</p>", tenantA, Instant.now().plusSeconds(3600)));

            assertThat(rowsFor(tenantA)).isEqualTo(1);
        }

        @Test
        @DisplayName("a tenant may NOT enqueue mail addressed to another tenant")
        void crossTenantWriteIsRefused() {
            /*
             * The hole this test was written for. `WITH CHECK
             * (app_current_user() IS NOT NULL)` asked only whether SOMEBODY was
             * signed in, not whether the row belonged to them -- so any
             * authenticated request could write a row carrying another
             * tenant's user_id, and the relay would deliver it.
             */
            assertThatThrownBy(() -> asTenant(tenantA, () -> outbox.enqueue(
                    "ml_" + suffix + "_x", "k_x_" + suffix, "b@example.com",
                    "s", "t", "<p>t</p>", tenantB, Instant.now().plusSeconds(3600))))
                    .hasMessageContaining("row-level security");

            assertThat(rowsFor(tenantB)).isZero();
        }

        @Test
        @DisplayName("an unstamped connection may not enqueue at all")
        void noTenantNoWrite() {
            // The production failure, in its original form: no tenant on the
            // session means no insert. Kept because it is still the behaviour
            // for any path that forgets to establish one.
            assertThatThrownBy(() -> withNoTenant(() -> outbox.enqueue(
                    "ml_" + suffix + "_n", "k_n_" + suffix, "n@example.com",
                    "s", "t", "<p>t</p>", tenantA, Instant.now().plusSeconds(3600))))
                    .hasMessageContaining("row-level security");
        }
    }

    @Nested
    @DisplayName("what the app role may read")
    class Reading {

        @Test
        @DisplayName("a tenant cannot read another tenant's outbox rows")
        void crossTenantReadIsBlind() throws Exception {
            seedOutbox(tenantB, "k_r_" + suffix);

            /*
             * V67 added a SELECT policy, and it is scoped to own rows only --
             * it exists because ON CONFLICT has to see the row it is
             * arbitrating against, not because anybody wanted the outbox
             * readable. So B sees its own message and A sees nothing of it.
             */
            assertThat(countAsTenant(tenantA)).isZero();
            assertThat(countAsTenant(tenantB)).isEqualTo(1);
            assertThat(rowsFor(tenantB)).isEqualTo(1);
        }

        @Test
        @DisplayName("the system role still sees everything it must drain")
        void systemStillReads() throws Exception {
            seedOutbox(tenantB, "k_s_" + suffix);

            assertThat(countAsSystem()).isPositive();
        }
    }

    // ------------------------------------------------------- account closure

    @Nested
    @DisplayName("closing an account")
    class Closing {

        @Test
        @DisplayName("commits the deletion and its outbox row together")
        void oneCommit() throws Exception {
            asTenantVoid(tenantA, () -> privacy.closeAccount(tenantA, "delete everything"));

            assertThat(userExists(tenantA)).isFalse();
            assertThat(rowsFor(tenantA)).isEqualTo(1);
        }

        @Test
        @DisplayName("the outbox row outlives the user row it names")
        void rowSurvivesTheUser() throws Exception {
            asTenantVoid(tenantA, () -> privacy.closeAccount(tenantA, "delete everything"));

            assertThat(userExists(tenantA)).isFalse();
            try (Connection c = owner();
                 PreparedStatement ps = c.prepareStatement(
                         "SELECT to_address, subject FROM mail_outbox WHERE user_id = ?")) {
                ps.setString(1, tenantA);
                try (ResultSet rs = ps.executeQuery()) {
                    assertThat(rs.next()).isTrue();
                    assertThat(rs.getString("subject")).contains("closed");
                }
            }
        }

        @Test
        @DisplayName("rolls the deletion back when the enqueue fails")
        void enqueueFailureUndoesTheDeletion() throws Exception {
            /*
             * The invariant the whole design rests on. If the record of the
             * deletion cannot be written, the deletion must not happen --
             * otherwise an account is destroyed and nobody is ever told.
             */
            Mockito.doThrow(new IllegalStateException("outbox unavailable"))
                    .when(outboxSpy).enqueue(Mockito.anyString(), Mockito.anyString(),
                            Mockito.anyString(), Mockito.anyString(), Mockito.anyString(),
                            Mockito.anyString(), Mockito.anyString(), Mockito.any());

            assertThatThrownBy(() ->
                    asTenantVoid(tenantA, () -> privacy.closeAccount(tenantA, "delete everything")))
                    .hasMessageContaining("outbox unavailable");

            assertThat(userExists(tenantA)).isTrue();
            assertThat(rowsFor(tenantA)).isZero();
        }

        @Test
        @DisplayName("leaves a row the relay can claim")
        void relayCanClaimIt() throws Exception {
            asTenantVoid(tenantA, () -> privacy.closeAccount(tenantA, "delete everything"));

            assertThat(countAsSystem()).isPositive();
        }
    }

    // ------------------------------------------------------------- plumbing

    /**
     * Tenant stamped, then a transaction opened -- in that order, because the
     * connection is stamped at checkout and checkout happens when the
     * transaction begins. A {@code @Modifying} query needs the transaction;
     * RLS needs the stamp to already be there when it starts.
     */
    private void asTenant(String userId, Runnable work) {
        TenantContext.setUserId(userId);
        try {
            new TransactionTemplate(txManager).executeWithoutResult(status -> work.run());
        } finally {
            TenantContext.clear();
        }
    }

    /** The same, with no tenant established at all. */
    private void withNoTenant(Runnable work) {
        TenantContext.clear();
        new TransactionTemplate(txManager).executeWithoutResult(status -> work.run());
    }

    private void asTenantVoid(String userId, Runnable work) {
        TenantContext.setUserId(userId);
        try {
            work.run();
        } finally {
            TenantContext.clear();
        }
    }

    private long countAsTenant(String userId) {
        TenantContext.setUserId(userId);
        try {
            return outbox.count();
        } finally {
            TenantContext.clear();
        }
    }

    private long countAsSystem() throws Exception {
        return TenantContext.asSystem(outbox::count);
    }

    private void seedOutbox(String userId, String key) throws Exception {
        try (Connection c = owner();
             PreparedStatement ps = c.prepareStatement("""
                     INSERT INTO mail_outbox
                        (id, dedupe_key, to_address, subject, body_text, body_html, user_id,
                         created_at, attempt_count, next_attempt_at, expires_at)
                     VALUES (?, ?, 'x@example.com', 's', 't', '<p>t</p>', ?,
                             now(), 0, now(), now() + interval '90 days')
                     """)) {
            ps.setString(1, "ml_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10));
            ps.setString(2, key);
            ps.setString(3, userId);
            ps.executeUpdate();
        }
    }

    private int rowsFor(String userId) {
        try (Connection c = owner();
             PreparedStatement ps = c.prepareStatement(
                     "SELECT COUNT(*) FROM mail_outbox WHERE user_id = ?")) {
            ps.setString(1, userId);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getInt(1);
            }
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private boolean userExists(String userId) {
        try (Connection c = owner();
             PreparedStatement ps = c.prepareStatement(
                     "SELECT COUNT(*) FROM users WHERE id = ?")) {
            ps.setString(1, userId);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getInt(1) > 0;
            }
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static void insertUser(Connection c, String id, String clerk) throws Exception {
        exec(c, "INSERT INTO users (id, clerk_user_id, email) VALUES (?, ?, ?)",
                id, "clerk_" + clerk, clerk + "@example.com");
    }

    private static void exec(Connection c, String sql, String... args) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setString(i + 1, args[i]);
            }
            ps.executeUpdate();
        }
    }

    private static Connection owner() {
        try {
            return DriverManager.getConnection(
                    System.getenv("REVERIE_IT_DB_URL"),
                    env("REVERIE_IT_DB_OWNER_USER", "REVERIE_IT_DB_USER"),
                    env("REVERIE_IT_DB_OWNER_PASSWORD", "REVERIE_IT_DB_PASSWORD"));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
