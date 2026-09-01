package com.reverie.repository;

import com.reverie.entity.ChatMessage;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface ChatMessageRepository extends JpaRepository<ChatMessage, String> {

    /** One conversation's turns, in order. The read behind every chat view. */
    List<ChatMessage> findByConversationIdOrderByCreatedAtAsc(String conversationId);

    /**
     * Ownership-scoped lookup for deletion.
     *
     * <p>Scoped in the query rather than fetched and then checked, so a message
     * belonging to someone else is indistinguishable from one that never
     * existed — how every other user-owned row here behaves.
     */
    Optional<ChatMessage> findByIdAndUserId(String id, String userId);

    long countByConversationId(String conversationId);

    /**
     * Every turn of a meeting's chats, across all of its conversations.
     *
     * <p>Only used when a meeting is deleted; the conversations cascade, and
     * this is here so nothing is left behind if that order ever changes.
     */
    void deleteByMeetingId(String meetingId);
}
