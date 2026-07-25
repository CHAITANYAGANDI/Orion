package com.recallix.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.dto.ChatMessageResponse;
import com.recallix.entity.ChatMessage;
import com.recallix.repository.ChatMessageRepository;
import com.recallix.repository.MeetingRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * "Ask-the-meeting" RAG chat. Verifies meeting ownership, proxies the question
 * to the ai-service (pgvector retrieval + grounded answer), and persists both
 * turns with their citations for history.
 */
@Service
public class ChatService {

    private final ChatMessageRepository messages;
    private final MeetingRepository meetings;
    private final AiClient ai;
    private final ObjectMapper mapper;

    public ChatService(ChatMessageRepository messages,
                       MeetingRepository meetings,
                       AiClient ai,
                       ObjectMapper mapper) {
        this.messages = messages;
        this.meetings = meetings;
        this.ai = ai;
        this.mapper = mapper;
    }

    @Transactional(readOnly = true)
    public List<ChatMessageResponse> history(String userId, String meetingId) {
        requireOwnedMeeting(userId, meetingId);
        return messages.findByMeetingIdOrderByCreatedAtAsc(meetingId).stream()
                .map(ChatMessageResponse::from)
                .toList();
    }

    @Transactional
    public ChatMessageResponse ask(String userId, String meetingId, String question) {
        requireOwnedMeeting(userId, meetingId);

        // Persist the user turn.
        ChatMessage userMsg = new ChatMessage();
        userMsg.setId(IdGenerator.generate("msg_"));
        userMsg.setMeetingId(meetingId);
        userMsg.setUserId(userId);
        userMsg.setRole("user");
        userMsg.setContent(question);
        messages.save(userMsg);

        // Retrieve + answer via the ai-service.
        AiClient.ChatResult result = ai.chat(meetingId, question);

        ChatMessage assistant = new ChatMessage();
        assistant.setId(IdGenerator.generate("msg_"));
        assistant.setMeetingId(meetingId);
        assistant.setUserId(userId);
        assistant.setRole("assistant");
        assistant.setContent(result.answer() == null ? "" : result.answer());
        assistant.setCitations(mapper.valueToTree(result.citations()));
        messages.save(assistant);

        return ChatMessageResponse.from(assistant);
    }

    private void requireOwnedMeeting(String userId, String meetingId) {
        meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));
    }
}
