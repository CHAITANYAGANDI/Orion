package com.recallix.repository;

import com.recallix.RecallixApplication;
import com.recallix.entity.Meeting;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * A presigned upload that nobody finished is not a meeting.
 *
 * <p>{@code MeetingService.createUploadUrl} writes a row at presign time, in
 * {@code CREATED}, so the object key can carry the meeting id.
 * {@code createMeeting} is what turns it into a meeting: it charges the
 * allowance, applies the title, folder and tags, and moves it to
 * {@code QUEUED}. Everything in between is a reservation.
 *
 * <p>Most reservations are never confirmed. An upload fails, a confirmation is
 * refused for having no minutes left, a tab is closed, somebody changes their
 * mind at the file picker. Nothing cleans those rows up and that was a
 * deliberate choice — charging at confirmation is what makes an abandoned
 * upload free — but being free was handled and being <em>invisible</em> was
 * not. Every one of them appeared in the list as a meeting stuck at "Uploading
 * recording… 1%", for ever, with no way to remove it: four of them accumulated
 * in ten minutes of ordinary use, two with the same title from one retried save.
 *
 * <p>So the two queries that feed a list exclude them, and this is the test of
 * that. It runs the real queries rather than a copy of them — a duplicated
 * {@code WHERE} clause in a test proves only that the test agrees with itself.
 *
 * <p><strong>Needs a PostgreSQL, and skips without one.</strong> Same switch as
 * {@code ApplicationContextSmokeTest}, for the same reason: {@code search} is
 * native PostgreSQL with jsonb containment in it, so there is nothing in memory
 * that could stand in for the thing that runs.
 */
@SpringBootTest(
        classes = RecallixApplication.class,
        webEnvironment = SpringBootTest.WebEnvironment.NONE)
@EnabledIfEnvironmentVariable(named = "RECALLIX_IT_DB_URL", matches = ".+",
        disabledReason = "needs a PostgreSQL to run the real list queries against")
class UnconfirmedMeetingsAreNotListedTest {

    @DynamicPropertySource
    static void realDatabaseAndNoBroker(DynamicPropertyRegistry registry) {
        String url = System.getenv("RECALLIX_IT_DB_URL");
        String owner = env("RECALLIX_IT_DB_OWNER_USER", "RECALLIX_IT_DB_USER");
        String password = env("RECALLIX_IT_DB_OWNER_PASSWORD", "RECALLIX_IT_DB_PASSWORD");

        registry.add("spring.datasource.url", () -> url);
        registry.add("spring.datasource.username", () -> owner);
        registry.add("spring.datasource.password", () -> password);
        registry.add("spring.flyway.url", () -> url);
        registry.add("spring.flyway.user", () -> owner);
        registry.add("spring.flyway.password", () -> password);
        registry.add("recallix.datasource.system.username", () -> owner);
        registry.add("recallix.datasource.system.password", () -> password);

        // Nowhere, quickly. Same reasoning as the smoke test: this is about
        // what the database returns, not about brokers.
        registry.add("spring.kafka.bootstrap-servers", () -> "localhost:1");
        registry.add("spring.kafka.security.protocol", () -> "PLAINTEXT");
        registry.add("spring.kafka.properties.default.api.timeout.ms", () -> "1000");
        registry.add("spring.kafka.properties.request.timeout.ms", () -> "1000");
        registry.add("spring.kafka.admin.fail-fast", () -> "false");
        registry.add("spring.kafka.admin.auto-create", () -> "false");
        // The database is shared with the deployment and there is no broker.
        registry.add("recallix.outbox.poll-ms", () -> "3600000");
    }

    private static String env(String preferred, String fallback) {
        String value = System.getenv(preferred);
        if (value == null || value.isBlank()) {
            value = System.getenv(fallback);
        }
        return value == null ? "" : value;
    }

    @Autowired private MeetingRepository meetings;

    private final String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    private final String userId = "usr_it_" + suffix;
    private final String reserved = "mtg_it_res_" + suffix;
    private final String confirmed = "mtg_it_con_" + suffix;

    /** One of each, owned by a user who exists only for this test. */
    @BeforeEach
    void twoRows() throws Exception {
        try (Connection c = connect()) {
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO users (id, clerk_user_id) VALUES (?, ?)")) {
                ps.setString(1, userId);
                ps.setString(2, "clerk_" + suffix);
                ps.executeUpdate();
            }
            insertMeeting(c, reserved, "abandoned presign", "CREATED");
            insertMeeting(c, confirmed, "a real meeting", "QUEUED");
            c.commit();
        }
    }

    @AfterEach
    void cleanUp() throws Exception {
        try (Connection c = connect()) {
            // Both meetings go with the user by cascade.
            try (PreparedStatement ps = c.prepareStatement("DELETE FROM users WHERE id = ?")) {
                ps.setString(1, userId);
                ps.executeUpdate();
            }
            c.commit();
        }
    }

    @Test
    @DisplayName("the meeting list leaves out an upload that was never confirmed")
    void theListLeavesItOut() {
        Page<Meeting> page = meetings.search(
                userId, null, null, null, null, null, false, PageRequest.of(0, 50));

        assertThat(page.getContent()).extracting(Meeting::getId).containsExactly(confirmed);
        // And the total with it. A count that included the hidden row would put
        // a page number under a list that cannot fill it.
        assertThat(page.getTotalElements()).isEqualTo(1);
    }

    @Test
    @DisplayName("the unfiled list leaves it out too")
    void theTreeLeavesItOut() {
        // A reservation has no folder — the folder is applied at confirmation —
        // so this is the one place in the tree it could ever have shown up.
        assertThat(meetings.findUnfiled(userId))
                .extracting(Meeting::getId)
                .containsExactly(confirmed);
    }

    @Test
    @DisplayName("it is still there, and still reachable by id")
    void itIsHiddenRatherThanGone() {
        // Hidden, not deleted. The row still owns the object key the upload was
        // presigned against, and `createMeeting` finds it by that key when a
        // slow upload finally lands — so deleting it here would break the
        // confirmation it is waiting for.
        assertThat(meetings.findByIdAndUserId(reserved, userId)).isPresent();
    }

    private void insertMeeting(Connection c, String id, String title, String status)
            throws Exception {
        try (PreparedStatement ps = c.prepareStatement("""
                INSERT INTO meetings (id, user_id, title, status, processing_attempt)
                VALUES (?, ?, ?, ?, 1)
                """)) {
            ps.setString(1, id);
            ps.setString(2, userId);
            ps.setString(3, title);
            ps.setString(4, status);
            ps.executeUpdate();
        }
    }

    private static Connection connect() throws Exception {
        String user = env("RECALLIX_IT_DB_OWNER_USER", "RECALLIX_IT_DB_USER");
        String password = env("RECALLIX_IT_DB_OWNER_PASSWORD", "RECALLIX_IT_DB_PASSWORD");
        Connection c = DriverManager.getConnection(
                System.getenv("RECALLIX_IT_DB_URL"),
                user.isBlank() ? "recallix_sys" : user,
                password);
        c.setAutoCommit(false);
        return c;
    }
}
