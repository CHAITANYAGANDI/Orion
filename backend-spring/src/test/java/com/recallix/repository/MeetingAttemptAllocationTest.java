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
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Two people press Reprocess at the same moment.
 *
 * <p>Every stale-callback check built in Phase 1 is keyed on
 * {@code processing_attempt}: a run says which attempt it is, and the meeting
 * says which attempt is current, and the comparison decides whether a result is
 * applied or discarded. That only works while the number is a unique name for a
 * run. Allocating it as a read followed by a write —
 *
 * <pre>
 *   both transactions read N
 *   both write N + 1
 * </pre>
 *
 * <p>— hands two live pipeline runs the same name. Both then look current to
 * every check in the system, both are applied, and the transcript that survives
 * is whichever landed last. The identity model does not fail loudly; it just
 * stops distinguishing anything.
 *
 * <p>This cannot be tested with mocks, because the thing under test is what
 * PostgreSQL does when two transactions want the same row. Two real connections,
 * autocommit off, with a latch making the overlap deterministic rather than a
 * sleep making it likely.
 *
 * <p><strong>Skipped unless a database is offered</strong>, same switch as
 * {@code OutboxClaimConcurrencyTest}. Rows are created under a throwaway user
 * and deleted afterwards.
 */
@EnabledIfEnvironmentVariable(named = "RECALLIX_IT_DB_URL", matches = ".+",
        disabledReason = "needs a PostgreSQL to contend for a row in")
class MeetingAttemptAllocationTest {

    private final String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    private final String userId = "usr_it_" + suffix;
    private final String meetingId = "mtg_it_" + suffix;

    @BeforeEach
    void createAMeeting() throws Exception {
        try (Connection c = connect()) {
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO users (id, clerk_user_id) VALUES (?, ?)")) {
                ps.setString(1, userId);
                ps.setString(2, "clerk_" + suffix);
                ps.executeUpdate();
            }
            try (PreparedStatement ps = c.prepareStatement("""
                    INSERT INTO meetings (id, user_id, title, processing_attempt)
                    VALUES (?, ?, 'attempt allocation probe', 1)
                    """)) {
                ps.setString(1, meetingId);
                ps.setString(2, userId);
                ps.executeUpdate();
            }
            c.commit();
        }
    }

    @AfterEach
    void deleteIt() throws Exception {
        try (Connection c = connect()) {
            // The meeting goes with the user by cascade.
            try (PreparedStatement ps = c.prepareStatement("DELETE FROM users WHERE id = ?")) {
                ps.setString(1, userId);
                ps.executeUpdate();
            }
            c.commit();
        }
    }

    private static Connection connect() throws Exception {
        String user = System.getenv().getOrDefault("RECALLIX_IT_DB_USER", "recallix_sys");
        String password = System.getenv().getOrDefault("RECALLIX_IT_DB_PASSWORD", "");
        Connection c = DriverManager.getConnection(System.getenv("RECALLIX_IT_DB_URL"), user, password);
        c.setAutoCommit(false);
        return c;
    }

    /** Exactly what reprocess() does: lock-and-read, then write read + 1. */
    private int allocate(Connection tx) throws Exception {
        int previous;
        try (PreparedStatement ps = tx.prepareStatement(
                "SELECT processing_attempt FROM meetings WHERE id = ? FOR NO KEY UPDATE")) {
            ps.setString(1, meetingId);
            try (ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).isTrue();
                previous = rs.getInt(1);
            }
        }
        try (PreparedStatement ps = tx.prepareStatement(
                "UPDATE meetings SET processing_attempt = ? WHERE id = ?")) {
            ps.setInt(1, previous + 1);
            ps.setString(2, meetingId);
            ps.executeUpdate();
        }
        return previous + 1;
    }

    /** The way it used to work: a read with nothing holding the row. */
    private int readWithoutLocking(Connection tx) throws Exception {
        try (PreparedStatement ps = tx.prepareStatement(
                "SELECT processing_attempt FROM meetings WHERE id = ?")) {
            ps.setString(1, meetingId);
            try (ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).isTrue();
                return rs.getInt(1);
            }
        }
    }

    private void write(Connection tx, int attempt) throws Exception {
        try (PreparedStatement ps = tx.prepareStatement(
                "UPDATE meetings SET processing_attempt = ? WHERE id = ?")) {
            ps.setInt(1, attempt);
            ps.setString(2, meetingId);
            ps.executeUpdate();
        }
    }

    private int attemptOnTheRow() throws Exception {
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                     "SELECT processing_attempt FROM meetings WHERE id = ?")) {
            ps.setString(1, meetingId);
            try (ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).isTrue();
                return rs.getInt(1);
            }
        }
    }

    @Test
    @DisplayName("the race is real: without the lock both callers get the same run number")
    void theRaceIsReal() throws Exception {
        // Proving the bug before proving the fix. If this ever stops allocating
        // the same number twice, the lock below has stopped being necessary and
        // this test should say so rather than quietly agreeing.
        //
        // The two writes are kept apart on purpose. An unlocked SELECT does not
        // block, but the UPDATE that follows it does — so running both
        // transactions to completion side by side would simply queue, and the
        // interesting part (that both decided on the same number while looking)
        // would be lost in the wait. What matters is the reads.
        try (Connection a = connect(); Connection b = connect()) {
            int aRead = readWithoutLocking(a);
            int bRead = readWithoutLocking(b);     // neither has written yet

            assertThat(aRead).isEqualTo(1);
            assertThat(bRead).isEqualTo(1);        // and so both will write 2

            write(a, aRead + 1);
            a.commit();
            write(b, bRead + 1);
            b.commit();
        }

        // Two reprocesses, one attempt number. Both runs are now called 2, both
        // look current to every staleness check in the system, and whichever
        // result lands last is the one the user gets.
        assertThat(attemptOnTheRow()).isEqualTo(2);
    }

    @Test
    @DisplayName("with the lock the second caller waits and gets the next number")
    void allocationIsSerialised() throws Exception {
        AtomicInteger fromA = new AtomicInteger();
        AtomicInteger fromB = new AtomicInteger();
        AtomicReference<Exception> failure = new AtomicReference<>();
        // A has the row; B is inside the lock-and-read and blocked on it. No
        // sleeping: the latch is what makes the overlap certain.
        CountDownLatch aHasTheRow = new CountDownLatch(1);
        CountDownLatch bIsWaiting = new CountDownLatch(1);

        Thread second = new Thread(() -> {
            try (Connection b = connect()) {
                aHasTheRow.await(10, TimeUnit.SECONDS);
                bIsWaiting.countDown();
                fromB.set(allocate(b));   // blocks here until A commits
                b.commit();
            } catch (Exception e) {
                failure.set(e);
            }
        });

        try (Connection a = connect()) {
            fromA.set(allocate(a));
            aHasTheRow.countDown();
            second.start();
            bIsWaiting.await(10, TimeUnit.SECONDS);
            // Wait for B to actually be blocked on the lock rather than sleeping
            // and hoping. Without this the test could commit A before B ever
            // reached the lock, in which case there was no contention and
            // nothing was proven.
            awaitSomeoneBlocked(a);
            a.commit();
        }
        second.join(20_000);

        assertThat(failure.get()).isNull();
        assertThat(fromA.get()).isEqualTo(2);
        assertThat(fromB.get()).isEqualTo(3);   // read AFTER A's commit, not before
        assertThat(attemptOnTheRow()).isEqualTo(3);
    }

    /** Block until another session is waiting on a lock, or give up trying. */
    private void awaitSomeoneBlocked(Connection watcher) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            try (PreparedStatement ps = watcher.prepareStatement("""
                    SELECT count(*) FROM pg_stat_activity
                     WHERE wait_event_type = 'Lock'
                       AND pid <> pg_backend_pid()
                    """);
                 ResultSet rs = ps.executeQuery()) {
                if (rs.next() && rs.getInt(1) > 0) {
                    return;
                }
            }
            TimeUnit.MILLISECONDS.sleep(50);
        }
        throw new IllegalStateException(
                "the second allocator never blocked on the row, so nothing was contended");
    }

    @Test
    @DisplayName("the number only ever goes up")
    void allocationIsMonotonic() throws Exception {
        for (int expected = 2; expected <= 6; expected++) {
            try (Connection tx = connect()) {
                assertThat(allocate(tx)).isEqualTo(expected);
                tx.commit();
            }
        }
        assertThat(attemptOnTheRow()).isEqualTo(6);
    }

    @Test
    @DisplayName("erasure and reprocess queue behind each other rather than deadlocking")
    void sharesOneLockOrderWithErasure() throws Exception {
        // Erasure takes the meeting row with FOR NO KEY UPDATE and then deletes
        // the transcript's children; reprocess now takes the same row with the
        // same mode before writing anything. Same row first, in both, which is
        // what keeps them out of each other's way -- the inverted order is what
        // produced a live deadlock during Phase 1.1d.
        try (Connection erasing = connect(); Connection reprocessing = connect()) {
            try (PreparedStatement ps = erasing.prepareStatement(
                    "SELECT id FROM meetings WHERE id = ? FOR NO KEY UPDATE")) {
                ps.setString(1, meetingId);
                ps.executeQuery().close();
            }
            erasing.commit();

            // No deadlock, no error: it simply gets its turn.
            assertThat(allocate(reprocessing)).isEqualTo(2);
            reprocessing.commit();
        }
    }
}
