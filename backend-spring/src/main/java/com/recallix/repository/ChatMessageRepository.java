package com.recallix.repository;

import com.recallix.entity.ChatMessage;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ChatMessageRepository extends JpaRepository<ChatMessage, String> {
    List<ChatMessage> findByMeetingIdOrderByCreatedAtAsc(String meetingId);

    /** Workspace-wide conversation: turns not tied to any single meeting. */
    List<ChatMessage> findByUserIdAndMeetingIdIsNullOrderByCreatedAtAsc(String userId);

    void deleteByMeetingId(String meetingId);

    void deleteByUserIdAndMeetingIdIsNull(String userId);
}
