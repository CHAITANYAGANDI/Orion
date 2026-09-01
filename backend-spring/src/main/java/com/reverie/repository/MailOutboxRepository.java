package com.reverie.repository;

import com.reverie.entity.MailMessage;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public interface MailOutboxRepository extends JpaRepository<MailMessage, String> {

    /**
     * The statement that decides which rows a relay owns.
     *
     * <p>{@code FOR UPDATE SKIP LOCKED}, exactly as {@link OutboxClaimSql}
     * explains at length for the Kafka outbox: each relay takes the rows it
     * selects for the length of its transaction, and a relay running
     * concurrently steps over them rather than waiting. The lock <em>is</em> the
     * claim, so there is no claim column, no lease to expire and no reaper —
     * a killed instance releases its rows by dying.
     *
     * <p>What is absent is the per-key FIFO subquery that statement has. Mail
     * has no ordering requirement: two messages to the same person are
     * independent, and holding one behind another would mean a single
     * hard-to-deliver address delaying everything else for that account.
     *
     * <p><b>Must be called inside a transaction.</b> Outside one the locks are
     * released the instant this returns and a second relay takes the same rows.
     */
    @Query(value = """
            SELECT m.*
              FROM mail_outbox m
             WHERE m.sent_at IS NULL
               AND m.abandoned_at IS NULL
               AND m.next_attempt_at <= now()
               AND (m.expires_at IS NULL OR m.expires_at > now())
             ORDER BY m.created_at, m.id
             LIMIT :batch
               FOR UPDATE SKIP LOCKED
            """, nativeQuery = true)
    List<MailMessage> claimBatch(@Param("batch") int batch);

    /**
     * Write the intent to send, unless it is already written.
     *
     * <p>Native and {@code ON CONFLICT DO NOTHING} rather than "check then
     * insert", which is not the same thing: two scheduler instances ticking in
     * the same second would both pass the check and both insert, and the unique
     * index would then turn the second into an exception that rolls back the
     * transaction it was enqueued in — for the retention pass, that would undo
     * the deletions. Letting the database absorb the conflict is what makes
     * enqueueing idempotent rather than merely careful.
     *
     * @return 1 when this call wrote the row, 0 when it already existed
     */
    @Modifying
    @Query(value = """
            INSERT INTO mail_outbox
                (id, dedupe_key, to_address, subject, body_text, body_html, user_id,
                 created_at, attempt_count, next_attempt_at, expires_at)
            VALUES
                (:id, :dedupeKey, :toAddress, :subject, :bodyText, :bodyHtml, :userId,
                 now(), 0, now(), :expiresAt)
            ON CONFLICT (dedupe_key) DO NOTHING
            """, nativeQuery = true)
    int enqueue(@Param("id") String id,
                @Param("dedupeKey") String dedupeKey,
                @Param("toAddress") String toAddress,
                @Param("subject") String subject,
                @Param("bodyText") String bodyText,
                @Param("bodyHtml") String bodyHtml,
                @Param("userId") String userId,
                @Param("expiresAt") Instant expiresAt);

    /**
     * Retire every pending row whose usefulness has run out.
     *
     * <p>Marked rather than deleted, so "this was never sent, and why" stays
     * answerable for the thirty days an abandoned row lives. The purge takes it
     * from there.
     *
     * <p>The claim query already skips these, so this is not what stops them
     * being delivered — it is what stops them sitting in the pending state
     * forever, invisible to both the relay and anyone reading the table.
     */
    @Modifying
    @Transactional
    @Query(value = """
            UPDATE mail_outbox
               SET abandoned_at = now(),
                   last_error = 'Expired before it could be delivered'
             WHERE sent_at IS NULL
               AND abandoned_at IS NULL
               AND expires_at IS NOT NULL
               AND expires_at <= now()
            """, nativeQuery = true)
    int retireExpired();

    /**
     * Retire a queued message that a later event has made wrong.
     *
     * <p>One caller: an "85% of your allowance is spent" still waiting when the
     * allowance runs out entirely. That message is not stale, it is false, and
     * the reader would get it after the one that supersedes it.
     *
     * <p>Only touches rows that have not gone out. A message already delivered
     * is history and is left alone.
     */
    @Modifying
    @Transactional
    @Query(value = """
            UPDATE mail_outbox
               SET abandoned_at = now(),
                   last_error = :reason
             WHERE dedupe_key = :dedupeKey
               AND sent_at IS NULL
               AND abandoned_at IS NULL
            """, nativeQuery = true)
    int supersede(@Param("dedupeKey") String dedupeKey, @Param("reason") String reason);

    /**
     * Delete abandoned rows older than a cutoff, a bounded batch at a time.
     *
     * <p>Thirty days rather than the seven a delivered row gets, and the
     * asymmetry is deliberate: an abandoned row is the record that somebody was
     * <em>not</em> told something. For the account-closure notice that is the
     * only trace the notice failed, and a week is not long enough for anybody to
     * notice, ask and look.
     */
    @Modifying
    @Transactional
    @Query(value = """
            DELETE FROM mail_outbox
             WHERE id IN (
                 SELECT id FROM mail_outbox
                  WHERE abandoned_at IS NOT NULL
                    AND abandoned_at < :cutoff
                  LIMIT :batch)
            """, nativeQuery = true)
    int deleteAbandonedBefore(@Param("cutoff") Instant cutoff, @Param("batch") int batch);

    Optional<MailMessage> findByDedupeKey(String dedupeKey);

    /**
     * Delete delivered rows older than a cutoff, a bounded batch at a time.
     *
     * <p>{@code sent_at IS NOT NULL} does two jobs, as it does on the Kafka
     * outbox: it keeps this away from work that has not happened, and it keeps
     * it away from abandoned rows, which are kept deliberately — an abandoned
     * row is never sent, so it can never match here.
     */
    @Modifying
    @Transactional
    @Query(value = """
            DELETE FROM mail_outbox
             WHERE id IN (
                 SELECT id FROM mail_outbox
                  WHERE sent_at IS NOT NULL
                    AND sent_at < :cutoff
                  LIMIT :batch)
            """, nativeQuery = true)
    int deleteSentBefore(@Param("cutoff") Instant cutoff, @Param("batch") int batch);
}
