package com.reverie.repository;

import jakarta.persistence.EntityManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * The embedded transcript, from the side that deletes it.
 *
 * <p>{@code transcript_chunks} is written and read entirely by the ai-service —
 * Spring has no entity for it, and should not grow one just to hold a vector
 * column it will never look at. What Spring does own is erasure, and a
 * transcript that has been deleted while its embeddings survive is worse than
 * one that was never deleted: chat and semantic search would keep answering out
 * of text the account holder was told had been removed, with no page left in the
 * product that could show it to them.
 *
 * <p>Deleting a whole meeting does not come through here — the foreign key
 * cascades. This exists for the narrower case where the transcript goes and the
 * meeting stays.
 */
@Repository
public class TranscriptChunkRepository {

    private final EntityManager em;

    public TranscriptChunkRepository(EntityManager em) {
        this.em = em;
    }

    /**
     * Drop every embedding of one meeting.
     *
     * <p>Runs under the caller's tenant, so row-level security is what stops
     * this deleting somebody else's vectors — the same protection every other
     * write in the application has, rather than a second ownership check that
     * could disagree with the first.
     *
     * @return how many chunks were removed
     */
    @Transactional
    public int deleteByMeetingId(String meetingId) {
        return em.createNativeQuery("DELETE FROM transcript_chunks WHERE meeting_id = :meetingId")
                .setParameter("meetingId", meetingId)
                .executeUpdate();
    }
}
