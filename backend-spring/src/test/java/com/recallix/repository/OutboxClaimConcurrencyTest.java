package com.recallix.repository;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
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
 * <p>Everything here is about {@code FOR UPDATE SKIP LOCKED}, and none of it can
 * be tested with a mock: a mocked repository will happily return whatever it is
 * told to, including two relays being handed the same row, which is the bug.
 * What has to be proven is what the database does when two transactions are open
 * at once, so these are two real JDBC connections with autocommit off, stepped
 * by hand. There are no sleeps and no threads — the overlap is created by
 * holding one transaction open, which is deterministic.
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
        try (Connection c = connect(env("RECALLIX_IT_DB_USER", "recallix_sys"),
                env("RECALLIX_IT_DB_PASSWORD", ""))) {
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

    // --- the outbox, as the relay sees it ----------------------------------- //

    /** Enqueue one event, committed, exactly as a business transaction would leave it. */
    private String enqueue(String meetingId, int ordinal) throws Exception {
        String id = "obx_it_" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        try (Connection c = connect(env("RECALLIX_IT_DB_USER", "recallix_sys"),
                env("RECALLIX_IT_DB_PASSWORD", ""))) {
            try (PreparedStatement ps = c.prepareStatement("""
                    INSERT INTO outbox_events (id, topic, partition_key, payload, published, created_at)
                    VALUES (?, ?, ?, ?::jsonb, false, now() + (? * interval '1 second'))
                    """)) {
                ps.setString(1, id);
                ps.setString(2, topic);
                ps.setString(3, meetingId);
                ps.setString(4, "{\"meetingId\":\"" + meetingId + "\",\"n\":" + ordinal + "}");
                // Explicit ordering rather than whatever now() happens to return:
                // created_at is transaction-start time and two inserts a
                // millisecond apart can share it.
                ps.setInt(5, ordinal);
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

    @Test
    @DisplayName("a failed send leaves the row exactly as it was, and claimable")
    void aFailedSendKeepsTheRowPending() throws Exception {
        // What the publisher's catch-and-break amounts to at this level: the
        // transaction ends without the row being marked, and the next tick —
        // this relay's or another's — finds it unchanged.
        String only = enqueue("mtg_a", 0);
        claim(relayA, 100);
        relayA.rollback();                     // Kafka refused; nothing marked

        List<String> retry = claim(relayB, 100);

        assertThat(retry).containsExactly(only);
        assertThat(publishedFlagOf(only)).isFalse();
    }

    private boolean publishedFlagOf(String id) throws Exception {
        try (Connection c = connect(env("RECALLIX_IT_DB_USER", "recallix_sys"),
                env("RECALLIX_IT_DB_PASSWORD", ""));
             PreparedStatement ps = c.prepareStatement(
                     "SELECT published FROM outbox_events WHERE id = ?")) {
            ps.setString(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).isTrue();
                return rs.getBoolean(1);
            }
        }
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

    // --- row-level security -------------------------------------------------- //

    @Test
    @DisplayName("the tenant role cannot see the outbox, let alone claim from it")
    @EnabledIfEnvironmentVariable(named = "RECALLIX_IT_APP_USER", matches = ".+",
            disabledReason = "needs the unprivileged role's credentials too")
    void theTenantRoleClaimsNothing() throws Exception {
        // outbox_events has forced row-level security and only an INSERT policy,
        // so a request-serving connection can write events and read none. This
        // is what stops an HTTP request — or SQL injection inside one — from
        // draining the queue.
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
}
