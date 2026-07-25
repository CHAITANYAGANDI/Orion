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
        persistTurn(userId, meetingId, "user", question, null);
        AiClient.ChatResult result = ai.chat(meetingId, question);
        return persistTurn(userId, meetingId, "assistant",
                result.answer() == null ? "" : result.answer(), result.citations());
    }

    // --- workspace-wide chat ------------------------------------------------ //

    /**
     * History for the user's workspace-wide conversation — the turns that are not
     * tied to any one meeting ({@code meeting_id IS NULL}).
     */
    @Transactional(readOnly = true)
    public List<ChatMessageResponse> workspaceHistory(String userId) {
        return messages.findByUserIdAndMeetingIdIsNullOrderByCreatedAtAsc(userId).stream()
                .map(ChatMessageResponse::from)
                .toList();
    }

    /**
     * Ask a question grounded across every meeting the user owns. No ownership
     * check is needed here: the ai-service filters retrieval by userId, so the
     * answer can only ever be grounded in this user's transcripts.
     */
    @Transactional
    public ChatMessageResponse askWorkspace(String userId, String question, List<String> meetingIds) {
        // If the caller narrowed the search, verify they own what they named.
        if (meetingIds != null) {
            meetingIds.forEach(id -> requireOwnedMeeting(userId, id));
        }
        persistTurn(userId, null, "user", question, null);
        AiClient.ChatResult result = ai.workspaceChat(userId, question, meetingIds);
        return persistTurn(userId, null, "assistant",
                result.answer() == null ? "" : result.answer(), result.citations());
    }

    @Transactional
    public void clearWorkspaceHistory(String userId) {
        messages.deleteByUserIdAndMeetingIdIsNull(userId);
    }

    // --- helpers ------------------------------------------------------------ //

    /** Persist one chat turn. A null meetingId marks it as workspace-scoped. */
    private ChatMessageResponse persistTurn(String userId,
                                            String meetingId,
                                            String role,
                                            String content,
                                            List<AiClient.Citation> citations) {
        ChatMessage msg = new ChatMessage();
        msg.setId(IdGenerator.generate("msg_"));
        msg.setMeetingId(meetingId);
        msg.setUserId(userId);
        msg.setRole(role);
        msg.setContent(content);
        if (citations != null) {
            msg.setCitations(mapper.valueToTree(citations));
        }
        messages.save(msg);
        return ChatMessageResponse.from(msg);
    }

    private void requireOwnedMeeting(String userId, String meetingId) {
        meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));
    }
}
