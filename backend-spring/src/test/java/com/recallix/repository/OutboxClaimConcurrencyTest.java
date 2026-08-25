package com.recallix.repository;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Two relays, one outbox, against a real PostgreSQL.
 *
 * <p>Everything here is about the claim query, and none of it can be tested with
 * a mock: a mocked repository will happily return whatever it is told to,
 * including two relays being handed the same row, which is the bug. What has to
 * be proven is what the database does when two transactions are open at once, so
 * these are two real JDBC connections with autocommit off, stepped by hand.
 * There are no sleeps and no threads — the overlap is created by holding one
 * transaction open, and the retry schedule is created by writing timestamps,
 * both of which are deterministic.
 *
 * <p><strong>Skipped unless a database is offered.</strong> Set
 * {@code RECALLIX_IT_DB_URL} (plus user/password) and it runs; otherwise the
 * suite passes it over. The connection must be the <em>system</em> role, because
 * that is the role the relay uses — {@code outbox_events} has forced row-level
 * security and no SELECT policy, so the tenant role reads nothing at all. The
 * last test here proves exactly that.
 *
 * <p><strong>Point it at a database with no relay attached.</strong> A running
 * backend polls this table every second and would publish the rows these tests
 * insert. A throwaway container, or the deployment stopped.
 *
 * <p>Rows are tagged with a topic nobody else uses and deleted afterwards, so a
 * failed run cannot leave anything a real relay would pick up.
 */
@EnabledIfEnvironmentVariable(named = "RECALLIX_IT_DB_URL", matches = ".+",
        disabledReason = "needs a PostgreSQL to lock rows in")
class OutboxClaimConcurrencyTest {

    /** Unique per run, so these rows are invisible to the per-key rule of any others. */
    private final String topic = "it_outbox_" + UUID.randomUUID().toString().substring(0, 8);

    private Connection relayA;
    private Connection relayB;

    @BeforeEach
    void openTwoRelays() throws Exception {
        relayA = connect(env("RECALLIX_IT_DB_USER", "recallix_sys"), env("RECALLIX_IT_DB_PASSWORD", ""));
        relayB = connect(env("RECALLIX_IT_DB_USER", "recallix_sys"), env("RECALLIX_IT_DB_PASSWORD", ""));
    }

    @AfterEach
    void cleanUp() throws Exception {
        for (Connection c : new Connection[]{relayA, relayB}) {
            if (c != null && !c.isClosed()) {
                c.rollback();
                c.close();
            }
        }
        try (Connection c = system()) {
            try (PreparedStatement ps = c.prepareStatement(
                    "DELETE FROM outbox_events WHERE topic = ?")) {
                ps.setString(1, topic);
                ps.executeUpdate();
            }
            c.commit();
        }
    }

    private static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }

    private static Connection connect(String user, String password) throws Exception {
        Connection c = DriverManager.getConnection(System.getenv("RECALLIX_IT_DB_URL"), user, password);
        c.setAutoCommit(false);
        return c;
    }

    private static Connection system() throws Exception {
        return connect(env("RECALLIX_IT_DB_USER", "recallix_sys"), env("RECALLIX_IT_DB_PASSWORD", ""));
    }

    // --- the outbox, as the relay sees it ----------------------------------- //

    /** Enqueue one event, committed, exactly as a business transaction would leave it. */
    private String enqueue(String meetingId, int ordinal) throws Exception {
        return enqueue(meetingId, ordinal, "0 seconds", null);
    }

    /**
     * Enqueue one event with a retry schedule already on it.
     *
     * @param dueIn      offset for {@code next_attempt_at}: {@code "1 hour"}
     *                   for a row that is backing off, {@code "-1 second"} for
     *                   one that has come due. An interval rather than a sleep.
     * @param failedIn   offset for {@code failed_at}, or null for a live row.
     */
    private String enqueue(String meetingId, int ordinal, String dueIn, String failedIn)
            throws Exception {
        String id = "obx_it_" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        try (Connection c = system()) {
            try (PreparedStatement ps = c.prepareStatement("""
                    INSERT INTO outbox_events
                        (id, topic, partition_key, payload, published, created_at,
                         attempt_count, next_attempt_at, last_error, failed_at)
                    VALUES (?, ?, ?, ?::jsonb, false, now() + (? * interval '1 second'),
                            ?, now() + ?::interval, ?,
                            CASE WHEN ?::text IS NULL THEN NULL ELSE now() + ?::interval END)
                    """)) {
                ps.setString(1, id);
                ps.setString(2, topic);
                ps.setString(3, meetingId);
                ps.setString(4, "{\"meetingId\":\"" + meetingId + "\",\"n\":" + ordinal + "}");
                // Explicit ordering rather than whatever now() happens to return:
                // created_at is transaction-start time and two inserts a
                // millisecond apart can share it.
                ps.setInt(5, ordinal);
                ps.setInt(6, "0 seconds".equals(dueIn) ? 0 : 1);
                ps.setString(7, dueIn);
                ps.setString(8, "0 seconds".equals(dueIn) ? null : "TimeoutException: broker down");
                ps.setString(9, failedIn);
                ps.setString(10, failedIn);
                ps.executeUpdate();
            }
            c.commit();
        }
        return id;
    }

    /** Run the production claim statement on this connection, without committing. */
    private List<String> claim(Connection relay, int batch) throws Exception {
        List<String> claimed = new ArrayList<>();
        try (PreparedStatement ps = relay.prepareStatement(
                OutboxClaimSql.CLAIM.replace(":batch", "?"))) {
            ps.setInt(1, batch);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    if (topic.equals(rs.getString("topic"))) {
                        claimed.add(rs.getString("id"));
                    }
                }
            }
        }
        return claimed;
    }

    private void markPublished(Connection relay, String id) throws Exception {
        try (PreparedStatement ps = relay.prepareStatement(
                "UPDATE outbox_events SET published = true WHERE id = ?")) {
            ps.setString(1, id);
            ps.executeUpdate();
        }
    }

    /** What the publisher writes when a send fails for an infrastructure reason. */
    private void recordTransientFailure(Connection relay, String id, String backoff) throws Exception {
        try (PreparedStatement ps = relay.prepareStatement("""
                UPDATE outbox_events
                   SET attempt_count = attempt_count + 1,
                       next_attempt_at = now() + ?::interval,
                       last_error = 'TimeoutException: broker down'
                 WHERE id = ?
                """)) {
            ps.setString(1, backoff);
            ps.setString(2, id);
            ps.executeUpdate();
        }
    }

    /** What it writes when the event can never be published. */
    private void retire(Connection relay, String id) throws Exception {
        try (PreparedStatement ps = relay.prepareStatement("""
                UPDATE outbox_events
                   SET attempt_count = attempt_count + 1,
                       last_error = 'RecordTooLargeException: 2MB',
                       failed_at = now()
                 WHERE id = ?
                """)) {
            ps.setString(1, id);
            ps.executeUpdate();
        }
    }

    private record Row(boolean published, int attemptCount, String lastError, boolean terminal) { }

    private Row read(String id) throws Exception {
        try (Connection c = system();
             PreparedStatement ps = c.prepareStatement("""
                     SELECT published, attempt_count, last_error, failed_at
                       FROM outbox_events WHERE id = ?
                     """)) {
            ps.setString(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).isTrue();
                return new Row(rs.getBoolean(1), rs.getInt(2), rs.getString(3),
                        rs.getTimestamp(4) != null);
            }
        }
    }

    // --- two relays over the same rows -------------------------------------- //

    @Test
    @DisplayName("a row one relay owns is invisible to the other")
    void twoRelaysNeverOwnTheSameRow() throws Exception {
        String only = enqueue("mtg_a", 0);

        List<String> a = claim(relayA, 100);
        List<String> b = claim(relayB, 100);   // A has not committed

        assertThat(a).containsExactly(only);
        assertThat(b).isEmpty();
    }

    @Test
    @DisplayName("two relays divide the backlog instead of duplicating it")
    void differentMeetingsProgressConcurrently() throws Exception {
        // Different meetings, so neither blocks the other on the per-key rule.
        String first = enqueue("mtg_a", 0);
        String second = enqueue("mtg_b", 1);
        String third = enqueue("mtg_c", 2);

        List<String> a = claim(relayA, 1);     // A takes one and holds it
        List<String> b = claim(relayB, 100);   // B takes what is left

        assertThat(a).containsExactly(first);
        assertThat(b).containsExactly(second, third);
        assertThat(a).doesNotContainAnyElementsOf(b);
    }

    @Test
    @DisplayName("a rolled-back claim hands the row straight back")
    void rollbackReleasesTheRow() throws Exception {
        // The reason there is no claim column: an instance that dies mid-batch
        // releases everything it held, with nothing to expire and nobody to
        // sweep. A lease would need both.
        String only = enqueue("mtg_a", 0);
        assertThat(claim(relayA, 100)).containsExactly(only);

        relayA.rollback();

        assertThat(claim(relayB, 100)).containsExactly(only);
    }

    @Test
    @DisplayName("a published row is never claimed again")
    void publishedRowsAreDone() throws Exception {
        String only = enqueue("mtg_a", 0);
        claim(relayA, 100);
        markPublished(relayA, only);
        relayA.commit();

        assertThat(claim(relayB, 100)).isEmpty();
    }

    // --- one meeting, in order ---------------------------------------------- //

    @Test
    @DisplayName("a meeting's second event cannot overtake its first")
    void perMeetingOrderHolds() throws Exception {
        // Two unpublished rows for one meeting is a real state, not a
        // hypothetical: Kafka can acknowledge attempt 1 and the mark can fail to
        // commit, leaving the row pending while the user reprocesses and
        // enqueues attempt 2.
        String firstEvent = enqueue("mtg_a", 0);
        enqueue("mtg_a", 1);

        List<String> a = claim(relayA, 100);
        List<String> b = claim(relayB, 100);

        // Only the head was ever eligible, and A has it.
        assertThat(a).containsExactly(firstEvent);
        assertThat(b).isEmpty();
    }

    @Test
    @DisplayName("the second event becomes eligible once the first is published")
    void theQueueMovesOnAfterTheHeadCommits() throws Exception {
        String firstEvent = enqueue("mtg_a", 0);
        String secondEvent = enqueue("mtg_a", 1);

        claim(relayA, 100);
        markPublished(relayA, firstEvent);
        relayA.commit();

        assertThat(claim(relayB, 100)).containsExactly(secondEvent);
    }

    @Test
    @DisplayName("a head that rolls back keeps its place in the queue")
    void theQueueDoesNotMoveOnAfterAFailure() throws Exception {
        String firstEvent = enqueue("mtg_a", 0);
        enqueue("mtg_a", 1);

        claim(relayA, 100);
        relayA.rollback();

        // Still the head. The second event has not been let past it.
        assertThat(claim(relayB, 100)).containsExactly(firstEvent);
    }

    @Test
    @DisplayName("one meeting waiting does not hold up another")
    void oneBlockedMeetingDoesNotBlockTheRest() throws Exception {
        // The whole reason for per-key rather than global FIFO. A stuck meeting
        // used to stop the queue for everybody, because the relay published
        // strictly in order and stopped at the first failure.
        String blockedHead = enqueue("mtg_a", 0);
        enqueue("mtg_a", 1);
        String otherMeeting = enqueue("mtg_b", 2);

        List<String> a = claim(relayA, 1);     // A holds meeting A's head

        assertThat(a).containsExactly(blockedHead);
        assertThat(claim(relayB, 100)).containsExactly(otherMeeting);
    }

    // --- backing off after a failure ---------------------------------------- //

    @Nested
    @DisplayName("a row that is backing off")
    class Backoff {

        @Test
        @DisplayName("keeps what the failed attempt wrote down")
        void retryMetadataIsDurable() throws Exception {
            String only = enqueue("mtg_a", 0);
            claim(relayA, 100);
            recordTransientFailure(relayA, only, "5 seconds");
            relayA.commit();

            Row row = read(only);
            assertThat(row.published()).isFalse();
            assertThat(row.terminal()).isFalse();
            assertThat(row.attemptCount()).isEqualTo(1);
            assertThat(row.lastError()).isEqualTo("TimeoutException: broker down");
        }

        @Test
        @DisplayName("is not claimed again until it is due")
        void notClaimableBeforeItIsDue() throws Exception {
            String only = enqueue("mtg_a", 0);
            claim(relayA, 100);
            recordTransientFailure(relayA, only, "1 hour");
            relayA.commit();

            // The old behaviour was to claim this row again one second later,
            // and every second after that, forever.
            assertThat(claim(relayB, 100)).isEmpty();
        }

        @Test
        @DisplayName("is claimed again once it is")
        void claimableAfterwards() throws Exception {
            String only = enqueue("mtg_a", 0);
            claim(relayA, 100);
            recordTransientFailure(relayA, only, "-1 second");   // the wait is over
            relayA.commit();

            assertThat(claim(relayB, 100)).containsExactly(only);
        }

        @Test
        @DisplayName("still blocks the next event for its own meeting")
        void stillBlocksItsOwnKey() throws Exception {
            // The subtle one. A1 is not eligible — it is waiting out its backoff
            // — but it has not gone anywhere, and A2 must not be published
            // ahead of it. The claim query asks whether an earlier row is still
            // ACTIVE, not whether it is DUE, precisely for this.
            String first = enqueue("mtg_a", 0);
            enqueue("mtg_a", 1);

            claim(relayA, 100);
            recordTransientFailure(relayA, first, "1 hour");
            relayA.commit();

            assertThat(claim(relayB, 100)).isEmpty();
        }

        @Test
        @DisplayName("does not block anybody else's")
        void doesNotBlockOtherKeys() throws Exception {
            String failing = enqueue("mtg_a", 0);
            String unrelated = enqueue("mtg_b", 1);

            claim(relayA, 1);                                    // A's head only
            recordTransientFailure(relayA, failing, "1 hour");
            relayA.commit();

            assertThat(claim(relayB, 100)).containsExactly(unrelated);
        }

        @Test
        @DisplayName("loses its schedule if the transaction that wrote it rolls back")
        void rollbackDiscardsTheSchedule() throws Exception {
            // Correct, not a bug: nothing was committed, so nothing happened.
            // The row is exactly as it was and is due immediately, which is the
            // same place a crashed relay leaves it. Worth pinning down, because
            // the alternative — half-applied backoff — would be a row that is
            // deferred without anybody having recorded why.
            String only = enqueue("mtg_a", 0);
            claim(relayA, 100);
            recordTransientFailure(relayA, only, "1 hour");
            relayA.rollback();

            assertThat(claim(relayB, 100)).containsExactly(only);
            assertThat(read(only).attemptCount()).isZero();
        }
    }

    // --- events that will never be published --------------------------------- //

    @Nested
    @DisplayName("a retired event")
    class Terminal {

        @Test
        @DisplayName("is never claimed again")
        void neverClaimedAgain() throws Exception {
            String poison = enqueue("mtg_a", 0);
            claim(relayA, 100);
            retire(relayA, poison);
            relayA.commit();

            assertThat(claim(relayB, 100)).isEmpty();
            assertThat(claim(relayA, 100)).isEmpty();
        }

        @Test
        @DisplayName("stops blocking the next event for its meeting")
        void stopsBlockingItsKey() throws Exception {
            // The point of having a terminal state at all. Before it, an event
            // that could never be published sat at the head of this meeting's
            // queue and every later event for the meeting waited behind it
            // forever — per-key rather than global, but still forever.
            String poison = enqueue("mtg_a", 0);
            String next = enqueue("mtg_a", 1);

            claim(relayA, 100);
            retire(relayA, poison);
            relayA.commit();

            assertThat(claim(relayB, 100)).containsExactly(next);
        }

        @Test
        @DisplayName("is kept, with everything needed to work out what happened")
        void isKeptForInspection() throws Exception {
            String poison = enqueue("mtg_a", 0);
            claim(relayA, 100);
            retire(relayA, poison);
            relayA.commit();

            Row row = read(poison);
            assertThat(row.terminal()).isTrue();
            assertThat(row.published()).isFalse();
            assertThat(row.attemptCount()).isEqualTo(1);
            assertThat(row.lastError()).isEqualTo("RecordTooLargeException: 2MB");
            // And the payload is still there — not deleted, not moved to a
            // dead-letter topic that would need Kafka to be up to write to.
            try (Connection c = system();
                 PreparedStatement ps = c.prepareStatement(
                         "SELECT payload FROM outbox_events WHERE id = ?")) {
                ps.setString(1, poison);
                try (ResultSet rs = ps.executeQuery()) {
                    assertThat(rs.next()).isTrue();
                    assertThat(rs.getString(1)).contains("mtg_a");
                }
            }
        }

        @Test
        @DisplayName("that was already terminal never becomes the head again")
        void staysOutOfTheChain() throws Exception {
            // Both of this meeting's events are behind a row that is already
            // retired, so the queue starts at the second one.
            enqueue("mtg_a", 0, "0 seconds", "-1 minute");
            String second = enqueue("mtg_a", 1);
            String third = enqueue("mtg_a", 2);

            assertThat(claim(relayA, 100)).containsExactly(second);
            relayA.rollback();

            // And nothing has quietly let the third one past the second either.
            assertThat(claim(relayB, 100)).containsExactly(second);
            assertThat(third).isNotNull();
        }
    }

    // --- two relays, with retries in the mix --------------------------------- //

    @Test
    @DisplayName("two relays still cannot own the same due row")
    void ownershipHoldsWithRetriesInPlay() throws Exception {
        String backingOff = enqueue("mtg_a", 0, "1 hour", null);
        String retired = enqueue("mtg_b", 1, "0 seconds", "-1 minute");
        String due = enqueue("mtg_c", 2);

        List<String> a = claim(relayA, 100);
        List<String> b = claim(relayB, 100);

        assertThat(a).containsExactly(due);       // the only eligible row
        assertThat(b).isEmpty();
        assertThat(backingOff).isNotNull();
        assertThat(retired).isNotNull();
    }

    // --- the nightly sweep ---------------------------------------------------- //

    @Nested
    @DisplayName("purging published events")
    class Purge {

        /**
         * The production statement, with one addition: it is pinned to this
         * run's topic.
         *
         * <p>Not cosmetic. Without it a test run against a database that has a
         * real deployment behind it would delete that deployment's published
         * history, which is the one thing a test in this file must not be able
         * to do. The guard has no bearing on what is being proven — every
         * assertion below is about the {@code published = true} and
         * {@code created_at} predicates, which are exactly as they ship.
         */
        private int purge(String olderThan, int batch) throws Exception {
            try (Connection c = system();
                 PreparedStatement ps = c.prepareStatement("""
                         DELETE FROM outbox_events
                          WHERE id IN (
                              SELECT id FROM outbox_events
                               WHERE published = true
                                 AND created_at < now() + ?::interval
                                 AND topic = ?
                               LIMIT ?)
                         """)) {
                ps.setString(1, olderThan);
                ps.setString(2, topic);
                ps.setInt(3, batch);
                int deleted = ps.executeUpdate();
                c.commit();
                return deleted;
            }
        }

        private boolean stillThere(String id) throws Exception {
            try (Connection c = system();
                 PreparedStatement ps = c.prepareStatement(
                         "SELECT 1 FROM outbox_events WHERE id = ?")) {
                ps.setString(1, id);
                try (ResultSet rs = ps.executeQuery()) {
                    return rs.next();
                }
            }
        }

        @Test
        @DisplayName("takes old published rows and nothing else")
        void takesOnlyWhatItShould() throws Exception {
            String published = enqueue("mtg_a", -3600);
            String pending = enqueue("mtg_b", -3600);
            String retired = enqueue("mtg_c", -3600, "0 seconds", "-1 hour");
            claim(relayA, 100);
            markPublished(relayA, published);
            relayA.commit();

            purge("-1 second", 1000);

            assertThat(stillThere(published)).as("published and old").isFalse();
            // Work that has not happened yet. Deleting it would lose a meeting.
            assertThat(stillThere(pending)).as("still pending").isTrue();
            // Kept deliberately: a retired event is the record of a meeting that
            // was never processed, and it is the one thing here somebody may
            // need to read months later.
            assertThat(stillThere(retired)).as("retired").isTrue();
        }

        @Test
        @DisplayName("leaves published rows inside the retention window alone")
        void respectsTheWindow() throws Exception {
            String recent = enqueue("mtg_a", 0);
            claim(relayA, 100);
            markPublished(relayA, recent);
            relayA.commit();

            purge("-7 days", 1000);

            assertThat(stillThere(recent)).isTrue();
        }

        @Test
        @DisplayName("is bounded by its batch size")
        void isBounded() throws Exception {
            String first = enqueue("mtg_a", -3600);
            String second = enqueue("mtg_b", -3600);
            claim(relayA, 100);
            markPublished(relayA, first);
            markPublished(relayA, second);
            relayA.commit();

            assertThat(purge("-1 second", 1)).isEqualTo(1);
            assertThat(purge("-1 second", 1)).isEqualTo(1);
            assertThat(purge("-1 second", 1)).isZero();
        }

        @Test
        @DisplayName("cannot touch a row a relay is holding")
        void doesNotFightTheRelay() throws Exception {
            // Not a lock-ordering argument: the two predicates are disjoint. The
            // relay claims published = false and the purge deletes published =
            // true, so they never want the same row and neither ever waits.
            String held = enqueue("mtg_a", -3600);
            assertThat(claim(relayA, 100)).containsExactly(held);

            assertThat(purge("-1 second", 1000)).isZero();

            assertThat(stillThere(held)).isTrue();
        }
    }

    // --- row-level security -------------------------------------------------- //

    @Test
    @DisplayName("the tenant role cannot see the outbox, let alone claim from it")
    @EnabledIfEnvironmentVariable(named = "RECALLIX_IT_APP_USER", matches = ".+",
            disabledReason = "needs the unprivileged role's credentials too")
    void theTenantRoleClaimsNothing() throws Exception {
        // outbox_events has forced row-level security and only an INSERT policy,
        // so a request-serving connection can write events and read none. This
        // is what stops an HTTP request — or SQL injection inside one — from
        // draining the queue, or from retiring an event to stop it being
        // delivered.
        enqueue("mtg_a", 0);

        try (Connection tenant = connect(System.getenv("RECALLIX_IT_APP_USER"),
                env("RECALLIX_IT_APP_PASSWORD", ""))) {
            try (PreparedStatement ps = tenant.prepareStatement(
                    "SELECT set_config('app.user_id', 'usr_anyone', false)")) {
                ps.execute();
            }
            assertThat(claim(tenant, 100)).isEmpty();
        }
    }

    @Test
    @DisplayName("nor retire an event to stop it being delivered")
    @EnabledIfEnvironmentVariable(named = "RECALLIX_IT_APP_USER", matches = ".+",
            disabledReason = "needs the unprivileged role's credentials too")
    void theTenantRoleCannotRetireAnything() throws Exception {
        // The terminal state is new, and it is the one column whose value stops
        // an event being delivered at all. There is no UPDATE policy either, so
        // a request-serving connection cannot reach it — the update matches no
        // rows rather than being refused, which is how RLS declines a write.
        String live = enqueue("mtg_a", 0);

        try (Connection tenant = connect(System.getenv("RECALLIX_IT_APP_USER"),
                env("RECALLIX_IT_APP_PASSWORD", ""))) {
            try (PreparedStatement ps = tenant.prepareStatement(
                    "SELECT set_config('app.user_id', 'usr_anyone', false)")) {
                ps.execute();
            }
            try (PreparedStatement ps = tenant.prepareStatement(
                    "UPDATE outbox_events SET failed_at = now() WHERE id = ?")) {
                ps.setString(1, live);
                assertThat(ps.executeUpdate()).isZero();
            }
            tenant.commit();
        }

        assertThat(read(live).terminal()).isFalse();
        assertThat(claim(relayA, 100)).containsExactly(live);
    }
}
