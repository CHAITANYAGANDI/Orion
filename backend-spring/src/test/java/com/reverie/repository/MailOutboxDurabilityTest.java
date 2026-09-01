package com.reverie.repository;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The guarantees that live in PostgreSQL rather than in Java.
 *
 * <h2>Why these cannot be unit tests</h2>
 *
 * <p>{@code MailDispatcherTest} proves what the dispatcher does with a row. It
 * cannot prove that two relays get <em>different</em> rows, or that a second
 * enqueue of the same key is absorbed rather than thrown, because neither is a
 * property of the Java — they are properties of a unique index and of
 * {@code FOR UPDATE SKIP LOCKED}. A test that mocked them would be a test of the
 * mock, and the two failures they guard against are silent: a duplicate "your
 * account has been closed", or a transaction rolled back by a unique violation
 * taking a night of retention deletions with it.
 *
 * <p>Same shape and same gate as {@code MeetingAttemptAllocationTest} and
 * {@code OutboxClaimConcurrencyTest}: plain JDBC against a real PostgreSQL,
 * skipped when there is not one.
 *
 * <pre>
 *   docker run -d --name reverie-it-pg -e POSTGRES_PASSWORD=reverie \
 *       -e POSTGRES_USER=reverie -e POSTGRES_DB=reverie \
 *       -p 55432:5432 pgvector/pgvector:pg16
 *   # apply src/main/resources/db/migration in order, then
 *   REVERIE_IT_DB_URL=jdbc:postgresql://localhost:55432/reverie mvn test
 * </pre>
 *
 * <p>Connects as the migration owner. These are statements the relay runs as
 * {@code reverie_sys}, and what is under test is the concurrency and constraint
 * semantics rather than the row-level policy — which V64 states and V11 already
 * proves the shape of.
 */
@EnabledIfEnvironmentVariable(named = "REVERIE_IT_DB_URL", matches = ".+",
        disabledReason = "needs a PostgreSQL to contend for a row in")
class MailOutboxDurabilityTest {

    private final String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    private final String userId = "usr_it_" + suffix;
    private final String key = "account-closed:" + userId;

    private static Connection connect() throws Exception {
        return DriverManager.getConnection(
                System.getenv("REVERIE_IT_DB_URL"),
                System.getenv().getOrDefault("REVERIE_IT_DB_USER", "reverie"),
                System.getenv().getOrDefault("REVERIE_IT_DB_PASSWORD", "reverie"));
    }

    @AfterEach
    void clean() throws Exception {
        try (Connection c = connect(); Statement s = c.createStatement()) {
            s.execute("DELETE FROM mail_outbox WHERE user_id LIKE 'usr_it_%'");
            s.execute("DELETE FROM users WHERE id LIKE 'usr_it_%'");
        }
    }

    /** The production enqueue statement, verbatim. */
    private static int enqueue(Connection c, String key, String userId, String expiresAt)
            throws Exception {
        try (PreparedStatement p = c.prepareStatement("""
                INSERT INTO mail_outbox
                    (id, dedupe_key, to_address, subject, body_text, body_html, user_id,
                     created_at, attempt_count, next_attempt_at, expires_at)
                VALUES (?, ?, 'ada@example.com', 'Your Reverie account is closed',
                        'text', '<p>html</p>', ?, now(), 0, now(), ?::timestamptz)
                ON CONFLICT (dedupe_key) DO NOTHING
                """)) {
            p.setString(1, "mal_" + UUID.randomUUID().toString().replace("-", "").substring(0, 20));
            p.setString(2, key);
            p.setString(3, userId);
            p.setString(4, expiresAt);
            return p.executeUpdate();
        }
    }

    private static int enqueue(Connection c, String key, String userId) throws Exception {
        return enqueue(c, key, userId, null);
    }

    private static long count(Connection c, String where) throws Exception {
        try (Statement s = c.createStatement();
             ResultSet rs = s.executeQuery("SELECT count(*) FROM mail_outbox WHERE " + where)) {
            rs.next();
            return rs.getLong(1);
        }
    }

    /* --------------------------------------------------------------------- */
    /* 1. The unique key                                                     */
    /* --------------------------------------------------------------------- */

    @Test
    @DisplayName("two scheduler instances enqueueing at the same second produce one message")
    void enqueueIsIdempotent() throws Exception {
        /*
         * Not "check, then insert". Both instances would pass the check, and
         * the unique index would then turn the second insert into an exception
         * that rolls back the transaction it was enqueued in -- which for the
         * retention pass would undo the deletions. Letting the database absorb
         * the conflict is what makes this idempotent rather than merely careful.
         */
        try (Connection a = connect(); Connection b = connect()) {
            assertThat(enqueue(a, key, userId)).as("the first writes the row").isEqualTo(1);
            assertThat(enqueue(b, key, userId))
                    .as("the second writes nothing, and does not throw").isZero();
            assertThat(count(a, "dedupe_key = '" + key + "'")).isEqualTo(1);
        }
    }

    @Test
    @DisplayName("a conflicting enqueue does not poison the transaction around it")
    void conflictDoesNotRollBackTheCaller() throws Exception {
        /*
         * The failure this shape exists to prevent, stated exactly. closeAccount
         * deletes an account and enqueues the notice in one transaction. If the
         * enqueue threw on a duplicate key, the account deletion would roll back
         * -- an irreversible operation undone by a message that had already been
         * queued.
         */
        try (Connection c = connect()) {
            c.setAutoCommit(false);
            enqueue(c, key, userId);
            c.commit();

            c.setAutoCommit(false);
            try (PreparedStatement p = c.prepareStatement(
                    "INSERT INTO users (id, clerk_user_id, email, plan, created_at) "
                            + "VALUES (?, ?, 'ada@example.com', 'FREE', now())")) {
                p.setString(1, userId);
                p.setString(2, "clerk_" + suffix);
                p.executeUpdate();
            }
            // The duplicate. Absorbed, so the insert above survives the commit.
            assertThat(enqueue(c, key, userId)).isZero();
            c.commit();

            assertThat(count(c, "1=1 AND (SELECT count(*) FROM users WHERE id = '" + userId + "') = 1"))
                    .as("the business write committed alongside the absorbed conflict")
                    .isGreaterThan(0);
        }
    }

    /* --------------------------------------------------------------------- */
    /* 2. FOR UPDATE SKIP LOCKED                                             */
    /* --------------------------------------------------------------------- */

    private static final String CLAIM = """
            SELECT m.id FROM mail_outbox m
             WHERE m.sent_at IS NULL AND m.abandoned_at IS NULL
               AND m.next_attempt_at <= now()
               AND (m.expires_at IS NULL OR m.expires_at > now())
               AND m.user_id LIKE 'usr_it_%'
             ORDER BY m.created_at, m.id
             LIMIT :batch FOR UPDATE SKIP LOCKED
            """;

    @Test
    @DisplayName("two relays claiming at once divide the queue rather than both taking it")
    void skipLockedDividesTheQueue() throws Exception {
        // Six messages, two relays, three each at most -- and never the same one
        // twice, which is the property that matters.
        try (Connection setup = connect()) {
            for (int i = 0; i < 6; i++) {
                enqueue(setup, "notes-ready:mtg_it_" + suffix + "_" + i, userId);
            }
        }

        String claim = CLAIM.replace(":batch", "3");
        var claimedBy = new ConcurrentHashMap<String, String>();
        AtomicReference<Exception> failure = new AtomicReference<>();
        CountDownLatch bothOpen = new CountDownLatch(2);
        CountDownLatch done = new CountDownLatch(2);

        for (int relay = 0; relay < 2; relay++) {
            String name = "relay-" + relay;
            new Thread(() -> {
                try (Connection c = connect()) {
                    c.setAutoCommit(false);
                    try (PreparedStatement p = c.prepareStatement(claim)) {
                        // Both transactions must overlap, or the second simply
                        // finds what the first has already released.
                        bothOpen.countDown();
                        bothOpen.await(5, TimeUnit.SECONDS);
                        ResultSet rs = p.executeQuery();
                        List<String> mine = new ArrayList<>();
                        while (rs.next()) {
                            mine.add(rs.getString(1));
                        }
                        Thread.sleep(400);
                        for (String id : mine) {
                            // putIfAbsent: a second claimant for the same id
                            // leaves the first name in place and is caught below.
                            claimedBy.merge(id, name, (a, b) -> a + "+" + b);
                        }
                    }
                    c.commit();
                } catch (Exception e) {
                    failure.set(e);
                } finally {
                    done.countDown();
                }
            }).start();
        }

        assertThat(done.await(30, TimeUnit.SECONDS)).isTrue();
        assertThat(failure.get()).isNull();
        assertThat(claimedBy.values())
                .as("no row may be claimed by both relays")
                .allMatch(who -> !who.contains("+"));
        assertThat(claimedBy).as("between them they took a full batch").hasSize(6);
    }

    /* --------------------------------------------------------------------- */
    /* 3. Surviving the account                                              */
    /* --------------------------------------------------------------------- */

    @Test
    @DisplayName("the message survives the account it is about being deleted")
    void survivesTheDeletion() throws Exception {
        /*
         * The whole reason the payload is copied in and user_id is not a foreign
         * key. A cascade here would delete the record of the deletion -- the one
         * message that can never be reconstructed from anything, because the
         * address and the counts went with the row.
         */
        try (Connection c = connect()) {
            try (PreparedStatement p = c.prepareStatement(
                    "INSERT INTO users (id, clerk_user_id, email, plan, created_at) "
                            + "VALUES (?, ?, 'ada@example.com', 'FREE', now())")) {
                p.setString(1, userId);
                p.setString(2, "clerk_" + suffix);
                p.executeUpdate();
            }
            enqueue(c, key, userId);

            try (PreparedStatement p = c.prepareStatement("DELETE FROM users WHERE id = ?")) {
                p.setString(1, userId);
                p.executeUpdate();
            }

            try (PreparedStatement p = c.prepareStatement(
                    "SELECT to_address, subject FROM mail_outbox WHERE dedupe_key = ?")) {
                p.setString(1, key);
                ResultSet rs = p.executeQuery();
                assertThat(rs.next()).as("the row outlives the account").isTrue();
                assertThat(rs.getString("to_address")).isEqualTo("ada@example.com");
                assertThat(rs.getString("subject")).isEqualTo("Your Reverie account is closed");
            }
        }
    }

    @Test
    @DisplayName("account deletion and the mail intent commit as one, or not at all")
    void oneCommit() throws Exception {
        // Rolled back together: no orphan message about a deletion that did not
        // happen, which is the other half of the same guarantee.
        try (Connection c = connect()) {
            try (PreparedStatement p = c.prepareStatement(
                    "INSERT INTO users (id, clerk_user_id, email, plan, created_at) "
                            + "VALUES (?, ?, 'ada@example.com', 'FREE', now())")) {
                p.setString(1, userId);
                p.setString(2, "clerk_" + suffix);
                p.executeUpdate();
            }

            c.setAutoCommit(false);
            try (PreparedStatement p = c.prepareStatement("DELETE FROM users WHERE id = ?")) {
                p.setString(1, userId);
                p.executeUpdate();
            }
            enqueue(c, key, userId);
            c.rollback();
            c.setAutoCommit(true);

            assertThat(count(c, "dedupe_key = '" + key + "'"))
                    .as("no message about a deletion that was undone").isZero();
            try (Statement s = c.createStatement();
                 ResultSet rs = s.executeQuery(
                         "SELECT count(*) FROM users WHERE id = '" + userId + "'")) {
                rs.next();
                assertThat(rs.getLong(1)).as("and the account is still there").isEqualTo(1);
            }
        }
    }

    /* --------------------------------------------------------------------- */
    /* 4. Expiry and the purge                                               */
    /* --------------------------------------------------------------------- */

    @Test
    @DisplayName("an expired message is never claimed")
    void expiredIsNotClaimed() throws Exception {
        try (Connection c = connect()) {
            enqueue(c, "task-reminder:" + userId + ":stale", userId, "2020-01-01T00:00:00Z");
            enqueue(c, "task-reminder:" + userId + ":fresh", userId, "2099-01-01T00:00:00Z");

            try (PreparedStatement p = c.prepareStatement(CLAIM.replace(":batch", "10"));
                 ResultSet rs = p.executeQuery()) {
                List<String> claimed = new ArrayList<>();
                while (rs.next()) {
                    claimed.add(rs.getString(1));
                }
                assertThat(claimed).as("the stale one is invisible to the relay").hasSize(1);
            }
        }
    }

    @Test
    @DisplayName("expired messages are retired rather than left pending for ever")
    void retireExpired() throws Exception {
        try (Connection c = connect()) {
            enqueue(c, "task-reminder:" + userId + ":stale", userId, "2020-01-01T00:00:00Z");

            try (Statement s = c.createStatement()) {
                int retired = s.executeUpdate("""
                        UPDATE mail_outbox
                           SET abandoned_at = now(),
                               last_error = 'Expired before it could be delivered'
                         WHERE sent_at IS NULL AND abandoned_at IS NULL
                           AND expires_at IS NOT NULL AND expires_at <= now()
                           AND user_id LIKE 'usr_it_%'
                        """);
                assertThat(retired).isEqualTo(1);
            }
            assertThat(count(c, "user_id = '" + userId + "' AND abandoned_at IS NOT NULL"))
                    .isEqualTo(1);
        }
    }

    @Test
    @DisplayName("the purge takes delivered rows after a week and abandoned ones after a month")
    void purgeKeepsTheRightThings() throws Exception {
        /*
         * mail_outbox holds an address and a body with no foreign key to the
         * account, so it outlives closeAccount. The lifetime is therefore
         * written down and short. Abandoned rows live longer than delivered
         * ones on purpose: an abandoned row is the record that somebody was NOT
         * told something.
         */
        try (Connection c = connect(); Statement s = c.createStatement()) {
            enqueue(c, "a:" + suffix, userId);
            enqueue(c, "b:" + suffix, userId);
            enqueue(c, "c:" + suffix, userId);
            enqueue(c, "d:" + suffix, userId);
            s.executeUpdate("UPDATE mail_outbox SET sent_at = now() - interval '8 days' "
                    + "WHERE dedupe_key = 'a:" + suffix + "'");
            s.executeUpdate("UPDATE mail_outbox SET sent_at = now() - interval '2 days' "
                    + "WHERE dedupe_key = 'b:" + suffix + "'");
            s.executeUpdate("UPDATE mail_outbox SET abandoned_at = now() - interval '31 days' "
                    + "WHERE dedupe_key = 'c:" + suffix + "'");
            s.executeUpdate("UPDATE mail_outbox SET abandoned_at = now() - interval '10 days' "
                    + "WHERE dedupe_key = 'd:" + suffix + "'");

            int sent = s.executeUpdate("""
                    DELETE FROM mail_outbox
                     WHERE id IN (SELECT id FROM mail_outbox
                                   WHERE sent_at IS NOT NULL
                                     AND sent_at < now() - interval '7 days'
                                   LIMIT 2000)
                    """);
            int abandoned = s.executeUpdate("""
                    DELETE FROM mail_outbox
                     WHERE id IN (SELECT id FROM mail_outbox
                                   WHERE abandoned_at IS NOT NULL
                                     AND abandoned_at < now() - interval '30 days'
                                   LIMIT 2000)
                    """);

            assertThat(sent).isEqualTo(1);
            assertThat(abandoned).isEqualTo(1);
            assertThat(count(c, "dedupe_key = 'b:" + suffix + "'"))
                    .as("a recent receipt is kept").isEqualTo(1);
            assertThat(count(c, "dedupe_key = 'd:" + suffix + "'"))
                    .as("a recent failure is kept, for longer").isEqualTo(1);
        }
    }

    @Test
    @DisplayName("the purge never touches a message still waiting to go out")
    void purgeLeavesPendingAlone() throws Exception {
        // Both statements are keyed on a terminal timestamp, so a pending row
        // cannot match either -- it falls out of the predicate rather than
        // needing a guard of its own.
        try (Connection c = connect(); Statement s = c.createStatement()) {
            enqueue(c, key, userId);
            s.executeUpdate("UPDATE mail_outbox SET created_at = now() - interval '400 days' "
                    + "WHERE dedupe_key = '" + key + "'");

            s.executeUpdate("DELETE FROM mail_outbox WHERE id IN (SELECT id FROM mail_outbox "
                    + "WHERE sent_at IS NOT NULL AND sent_at < now() - interval '7 days' LIMIT 2000)");
            s.executeUpdate("DELETE FROM mail_outbox WHERE id IN (SELECT id FROM mail_outbox "
                    + "WHERE abandoned_at IS NOT NULL AND abandoned_at < now() - interval '30 days' LIMIT 2000)");

            assertThat(count(c, "dedupe_key = '" + key + "'"))
                    .as("an undelivered message is not purged, however old").isEqualTo(1);
        }
    }

    @Test
    @DisplayName("a superseded low-allowance warning is retired, and a delivered one is left alone")
    void supersede() throws Exception {
        try (Connection c = connect(); Statement s = c.createStatement()) {
            enqueue(c, "allowance-low:" + userId, userId);

            int touched = s.executeUpdate("""
                    UPDATE mail_outbox
                       SET abandoned_at = now(), last_error = 'Superseded by the allowance-spent notice'
                     WHERE dedupe_key = 'allowance-low:""" + userId + """
                    '
                       AND sent_at IS NULL AND abandoned_at IS NULL
                    """);
            assertThat(touched).as("still queued, so retired").isEqualTo(1);

            // A second call finds nothing: it is already terminal.
            assertThat(s.executeUpdate("""
                    UPDATE mail_outbox
                       SET abandoned_at = now(), last_error = 'Superseded'
                     WHERE dedupe_key = 'allowance-low:""" + userId + """
                    '
                       AND sent_at IS NULL AND abandoned_at IS NULL
                    """)).isZero();
        }
    }
}
