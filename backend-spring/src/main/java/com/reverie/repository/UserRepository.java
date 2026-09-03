package com.reverie.repository;

import com.reverie.entity.UserEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

public interface UserRepository extends JpaRepository<UserEntity, String> {

    Optional<UserEntity> findByClerkUserId(String clerkUserId);

    /**
     * Everyone who has asked for their data to be thrown away eventually.
     *
     * <p>Selected here rather than filtered in the loop so that a workspace with
     * no retention policy — which is every workspace by default — costs the
     * nightly pass one query and nothing else. Runs under the system connection;
     * see {@code RetentionService} for how each account's own tenant is
     * re-established before anything is deleted.
     */
    @Query("""
            SELECT u FROM UserEntity u
             WHERE u.audioRetentionDays IS NOT NULL
                OR u.meetingRetentionDays IS NOT NULL
            """)
    List<UserEntity> findWithRetentionPolicy();

    /**
     * Create the row for a Clerk subject, unless somebody else just did.
     *
     * <h2>Why this is not a save()</h2>
     *
     * <p>A browser opening the app for the first time fires several requests at
     * once, and every one of them authenticates the same brand-new subject.
     * Read-then-save gives all of them an empty lookup, so all of them insert,
     * one wins and the rest come back 500 against
     * {@code users_clerk_user_id_key} — the user's first page load is mostly
     * errors, and a refresh fixes it, which is the worst way for a bug to
     * present.
     *
     * <p>{@code ON CONFLICT DO NOTHING} moves the decision into the database,
     * where it is one statement and therefore atomic. The loser does not fail;
     * it simply inserts nothing and reads the winner's row.
     *
     * <h2>Why the loser waits rather than losing</h2>
     *
     * <p>If the winner has inserted but not yet committed, this statement blocks
     * on the unique index rather than returning. It resumes when that
     * transaction ends: committed, and the conflict clause swallows the insert;
     * rolled back, and this one takes the row instead. Either way the caller
     * ends up looking at exactly one committed row, which is the whole point.
     *
     * <p>The follow-up {@code findByClerkUserId} sees it because Postgres reads
     * committed by default and takes a fresh snapshot per statement. Under
     * {@code REPEATABLE READ} the snapshot would predate the winner's commit and
     * the lookup would come back empty — nothing here sets that, and this is the
     * reason not to.
     *
     * <h2>Columns</h2>
     *
     * <p>{@code plan} is written out because {@link UserEntity} sets it
     * explicitly and this path must not quietly disagree. Everything else a new
     * row needs — {@code created_at}, {@code muted_notifications} and the five
     * email switches — has a column default identical to the field initialiser
     * it replaces, so a row
     * made here and a row made by Hibernate are the same row.
     *
     * @return 1 when this caller created the row, 0 when it already existed
     */
    @Modifying
    @Query(value = """
            INSERT INTO users (id, clerk_user_id, email, plan)
            VALUES (:id, :clerkUserId, :email, 'FREE')
            ON CONFLICT (clerk_user_id) DO NOTHING
            """, nativeQuery = true)
    int insertIfAbsent(@Param("id") String id,
                       @Param("clerkUserId") String clerkUserId,
                       @Param("email") String email);
}
