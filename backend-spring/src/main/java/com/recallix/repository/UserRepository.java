package com.recallix.repository;

import com.recallix.entity.UserEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

public interface UserRepository extends JpaRepository<UserEntity, String> {

    Optional<UserEntity> findByClerkUserId(String clerkUserId);

    /**
     * Who is owed a reminder digest today.
     *
     * <p>The date check is in the query rather than in the loop so that a
     * restart mid-run cannot re-mail the users already done: the second pass
     * simply does not select them. Runs under the system connection, which is
     * the only place a query across every tenant is legitimate.
     */
    @Query("""
            SELECT u FROM UserEntity u
             WHERE u.taskReminders = true
               AND (u.taskReminderSentOn IS NULL OR u.taskReminderSentOn < :today)
            """)
    List<UserEntity> findAwaitingTaskReminder(@Param("today") LocalDate today);

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
}
