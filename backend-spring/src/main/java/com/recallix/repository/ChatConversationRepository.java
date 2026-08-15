package com.recallix.repository;

import com.recallix.entity.ChatConversation;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface ChatConversationRepository extends JpaRepository<ChatConversation, String> {

    /**
     * The history picker's read: one scope, most recently spoken to first.
     *
     * <p>Two methods rather than one with a nullable argument because JPQL
     * treats {@code = null} as unknown rather than as a match, so a single
     * derived query would silently return nothing for the workspace chat.
     */
    List<ChatConversation> findByUserIdAndMeetingIdOrderByUpdatedAtDesc(String userId, String meetingId);

    List<ChatConversation> findByUserIdAndMeetingIdIsNullOrderByUpdatedAtDesc(String userId);

    /** The one to reopen when a chat is opened without naming a conversation. */
    Optional<ChatConversation> findFirstByUserIdAndMeetingIdOrderByUpdatedAtDesc(String userId, String meetingId);

    Optional<ChatConversation> findFirstByUserIdAndMeetingIdIsNullOrderByUpdatedAtDesc(String userId);

    Optional<ChatConversation> findByIdAndUserId(String id, String userId);
}
