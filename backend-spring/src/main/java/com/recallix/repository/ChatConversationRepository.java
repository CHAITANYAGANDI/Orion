package com.recallix.repository;

import com.recallix.entity.ChatConversation;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface ChatConversationRepository extends JpaRepository<ChatConversation, String> {

    /**
     * The history picker's read: one scope, most recently spoken to first.
     *
     * <p>A method per scope rather than one with nullable arguments because JPQL
     * treats {@code = null} as unknown rather than as a match, so a single
     * derived query would silently return nothing for the workspace chat.
     *
     * <p>The workspace variants test <em>both</em> ids for null, which is the
     * whole reason they changed in V30. "Workspace" used to mean "no meeting";
     * with projects it means "no meeting and no project", and the old spelling
     * would have listed every project's threads in the workspace history and
     * deleted them when it was cleared.
     */
    List<ChatConversation> findByUserIdAndMeetingIdOrderByUpdatedAtDesc(String userId, String meetingId);

    /** How many threads exist across every scope — the privacy page's inventory. */
    long countByUserId(String userId);

    List<ChatConversation> findByUserIdAndProjectIdOrderByUpdatedAtDesc(String userId, String projectId);

    List<ChatConversation> findByUserIdAndMeetingIdIsNullAndProjectIdIsNullOrderByUpdatedAtDesc(String userId);

    /** The one to reopen when a chat is opened without naming a conversation. */
    Optional<ChatConversation> findFirstByUserIdAndMeetingIdOrderByUpdatedAtDesc(String userId, String meetingId);

    Optional<ChatConversation> findFirstByUserIdAndProjectIdOrderByUpdatedAtDesc(String userId, String projectId);

    Optional<ChatConversation> findFirstByUserIdAndMeetingIdIsNullAndProjectIdIsNullOrderByUpdatedAtDesc(String userId);

    Optional<ChatConversation> findByIdAndUserId(String id, String userId);
}
