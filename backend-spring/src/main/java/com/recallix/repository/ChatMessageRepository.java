package com.recallix.repository;

import com.recallix.entity.ChatMessage;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ChatMessageRepository extends JpaRepository<ChatMessage, String> {
    List<ChatMessage> findByMeetingIdOrderByCreatedAtAsc(String meetingId);
    void deleteByMeetingId(String meetingId);
}
