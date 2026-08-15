package com.recallix.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.recallix.common.ApiException;
import com.recallix.common.ConversationTitle;
import com.recallix.common.IdGenerator;
import com.recallix.dto.ChatMessageResponse;
import com.recallix.dto.ConversationResponse;
import com.recallix.entity.ChatConversation;
import com.recallix.entity.ChatMessage;
import com.recallix.repository.ChatConversationRepository;
import com.recallix.repository.ChatMessageRepository;
import com.recallix.repository.MeetingRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * RAG chat at two scopes — one meeting, or the whole workspace — organised into
 * named conversations.
 *
 * <p>Before V28 each scope was one unbounded thread, which made "clear it all"
 * the only way to tidy up and therefore the thing people did. A conversation is
 * the unit somebody actually means: a question and its follow-ups, keepable or
 * discardable on its own.
 */
@Service
public class ChatService {

    private final ChatMessageRepository messages;
    private final ChatConversationRepository conversations;
    private final MeetingRepository meetings;
    private final AiClient ai;
    private final ObjectMapper mapper;

    public ChatService(ChatMessageRepository messages,
                       ChatConversationRepository conversations,
                       MeetingRepository meetings,
                       AiClient ai,
                       ObjectMapper mapper) {
        this.messages = messages;
        this.conversations = conversations;
        this.meetings = meetings;
        this.ai = ai;
        this.mapper = mapper;
    }

    // --- conversations ------------------------------------------------------ //

    /** Every conversation at one scope, most recently spoken to first. */
    @Transactional(readOnly = true)
    public List<ConversationResponse> listConversations(String userId, String meetingId) {
        if (meetingId != null) {
            requireOwnedMeeting(userId, meetingId);
        }
        return scopeConversations(userId, meetingId).stream()
                .map(c -> ConversationResponse.from(c, messages.countByConversationId(c.getId())))
                .toList();
    }

    /**
     * Start a new thread.
     *
     * <p>Created empty and untitled: the title comes from the first question,
     * and asking for one up front would make starting a chat a form to fill in.
     */
    @Transactional
    public ConversationResponse createConversation(String userId, String meetingId) {
        if (meetingId != null) {
            requireOwnedMeeting(userId, meetingId);
        }
        return ConversationResponse.from(newConversation(userId, meetingId), 0);
    }

    @Transactional
    public ConversationResponse renameConversation(String userId, String conversationId, String title) {
        ChatConversation c = ownedConversation(userId, conversationId);
        String clean = title == null ? "" : title.trim();
        if (clean.isEmpty()) {
            throw ApiException.badRequest("A conversation needs a name.");
        }
        c.setTitle(clean.length() > 200 ? clean.substring(0, 200) : clean);
        // Deliberately does not touch updatedAt: renaming is not talking to it,
        // and bumping it would shuffle the list under someone who was tidying.
        return ConversationResponse.from(c, messages.countByConversationId(c.getId()));
    }

    /** Delete one thread and everything in it. Messages cascade in the schema. */
    @Transactional
    public void deleteConversation(String userId, String conversationId) {
        conversations.delete(ownedConversation(userId, conversationId));
    }

    /** Delete every conversation at one scope — "start over" rather than tidying. */
    @Transactional
    public void clearScope(String userId, String meetingId) {
        if (meetingId != null) {
            requireOwnedMeeting(userId, meetingId);
        }
        conversations.deleteAll(scopeConversations(userId, meetingId));
    }

    // --- reading ------------------------------------------------------------ //

    /**
     * One conversation's turns.
     *
     * <p>A null {@code conversationId} means "whatever I was last saying here",
     * which is what opening a chat should show. Empty when there is nothing yet.
     */
    @Transactional(readOnly = true)
    public List<ChatMessageResponse> history(String userId, String meetingId, String conversationId) {
        if (meetingId != null) {
            requireOwnedMeeting(userId, meetingId);
        }
        Optional<ChatConversation> target = conversationId == null
                ? mostRecent(userId, meetingId)
                : Optional.of(requireScoped(ownedConversation(userId, conversationId), meetingId));

        return target
                .map(c -> messages.findByConversationIdOrderByCreatedAtAsc(c.getId()).stream()
                        .map(ChatMessageResponse::from)
                        .toList())
                .orElseGet(List::of);
    }

    // --- asking ------------------------------------------------------------- //

    @Transactional
    public ChatMessageResponse ask(String userId, String meetingId, String question, String conversationId) {
        requireOwnedMeeting(userId, meetingId);
        ChatConversation conversation = resolveForAsk(userId, meetingId, conversationId);

        persistTurn(userId, meetingId, conversation, "user", question, null);
        AiClient.ChatResult result = ai.chat(userId, meetingId, question);
        ChatMessageResponse answer = persistTurn(userId, meetingId, conversation, "assistant",
                result.answer() == null ? "" : result.answer(), result.citations());

        touch(conversation, question);
        return answer;
    }

    /**
     * Ask a question grounded across every meeting the user owns. No ownership
     * check is needed for retrieval: the ai-service filters by userId, so the
     * answer can only ever be grounded in this user's transcripts.
     */
    @Transactional
    public ChatMessageResponse askWorkspace(String userId, String question,
                                            List<String> meetingIds, String conversationId) {
        // If the caller narrowed the search, verify they own what they named.
        if (meetingIds != null) {
            meetingIds.forEach(id -> requireOwnedMeeting(userId, id));
        }
        ChatConversation conversation = resolveForAsk(userId, null, conversationId);

        persistTurn(userId, null, conversation, "user", question, null);
        AiClient.ChatResult result = ai.workspaceChat(userId, question, meetingIds);
        ChatMessageResponse answer = persistTurn(userId, null, conversation, "assistant",
                result.answer() == null ? "" : result.answer(), result.citations());

        touch(conversation, question);
        return answer;
    }

    // --- deleting one exchange ---------------------------------------------- //

    /**
     * Remove a message and the turn that goes with it.
     *
     * <p>Deleting one half of an exchange is almost never what somebody means.
     * A question whose answer is gone reads as a request the app ignored, and an
     * answer with no question is a claim about nothing — in a log whose whole
     * value is re-reading what you asked and what it said, both are worse than
     * leaving the exchange alone.
     *
     * <p>Safe to do because turns are independent: neither {@link #ask} nor
     * {@link #askWorkspace} sends prior messages to the model, so removing a
     * pair cannot change how a later question is answered. If conversational
     * memory is ever added this becomes a decision about rewriting history and
     * should be revisited.
     *
     * @return how many rows were removed — one for a turn with no partner.
     */
    @Transactional
    public int deleteExchange(String userId, String messageId) {
        ChatMessage target = messages.findByIdAndUserId(messageId, userId)
                .orElseThrow(() -> ApiException.notFound("Message not found"));

        // Paired inside its own conversation. Scanning the whole scope would
        // pair a turn with one from a different thread that happened to be
        // written next.
        List<ChatMessage> thread = messages.findByConversationIdOrderByCreatedAtAsc(
                target.getConversationId());

        int index = -1;
        for (int i = 0; i < thread.size(); i++) {
            if (thread.get(i).getId().equals(messageId)) {
                index = i;
                break;
            }
        }

        List<ChatMessage> doomed = new ArrayList<>();
        doomed.add(target);

        // A user turn is answered by the assistant turn after it; an assistant
        // turn answers the user turn before it. Anything else — a question that
        // errored before an answer was written, an answer whose question was
        // already deleted — leaves the partner slot empty, and removing the one
        // row is the whole job.
        if (index >= 0) {
            ChatMessage partner = null;
            if ("user".equals(target.getRole()) && index + 1 < thread.size()) {
                ChatMessage next = thread.get(index + 1);
                if ("assistant".equals(next.getRole())) {
                    partner = next;
                }
            } else if ("assistant".equals(target.getRole()) && index > 0) {
                ChatMessage previous = thread.get(index - 1);
                if ("user".equals(previous.getRole())) {
                    partner = previous;
                }
            }
            if (partner != null) {
                doomed.add(partner);
            }
        }

        messages.deleteAll(doomed);

        // An emptied conversation is a row nobody can reach and an entry in the
        // history list that opens onto nothing.
        if (doomed.size() >= thread.size()) {
            conversations.findByIdAndUserId(target.getConversationId(), userId)
                    .ifPresent(conversations::delete);
        }
        return doomed.size();
    }

    // --- helpers ------------------------------------------------------------ //

    private List<ChatConversation> scopeConversations(String userId, String meetingId) {
        return meetingId == null
                ? conversations.findByUserIdAndMeetingIdIsNullOrderByUpdatedAtDesc(userId)
                : conversations.findByUserIdAndMeetingIdOrderByUpdatedAtDesc(userId, meetingId);
    }

    private Optional<ChatConversation> mostRecent(String userId, String meetingId) {
        return meetingId == null
                ? conversations.findFirstByUserIdAndMeetingIdIsNullOrderByUpdatedAtDesc(userId)
                : conversations.findFirstByUserIdAndMeetingIdOrderByUpdatedAtDesc(userId, meetingId);
    }

    /**
     * The conversation a question belongs to: the one named, the one last used,
     * or a new one. Asking without naming a thread must never fail — the chat
     * box is the primary control and a first-time user has no conversation yet.
     */
    private ChatConversation resolveForAsk(String userId, String meetingId, String conversationId) {
        if (conversationId != null) {
            return requireScoped(ownedConversation(userId, conversationId), meetingId);
        }
        return mostRecent(userId, meetingId).orElseGet(() -> newConversation(userId, meetingId));
    }

    private ChatConversation newConversation(String userId, String meetingId) {
        ChatConversation c = new ChatConversation();
        c.setId(IdGenerator.conversation());
        c.setUserId(userId);
        c.setMeetingId(meetingId);
        c.setTitle(ConversationTitle.UNTITLED);
        return conversations.save(c);
    }

    /**
     * Move it to the top of the list, and name it if this was its first
     * question. The title is never overwritten afterwards: a thread that
     * renamed itself on every message would be unfindable, and a rename the
     * user made would be undone by their next question.
     */
    private void touch(ChatConversation conversation, String question) {
        conversation.setUpdatedAt(Instant.now());
        if (isUnnamed(conversation)) {
            conversation.setTitle(ConversationTitle.from(question));
        }
    }

    private static boolean isUnnamed(ChatConversation c) {
        String t = c.getTitle();
        return t == null || t.isBlank() || ConversationTitle.UNTITLED.equals(t);
    }

    /** Persist one chat turn. A null meetingId marks it as workspace-scoped. */
    private ChatMessageResponse persistTurn(String userId,
                                            String meetingId,
                                            ChatConversation conversation,
                                            String role,
                                            String content,
                                            List<AiClient.Citation> citations) {
        ChatMessage msg = new ChatMessage();
        msg.setId(IdGenerator.generate("msg_"));
        msg.setMeetingId(meetingId);
        msg.setConversationId(conversation.getId());
        msg.setUserId(userId);
        msg.setRole(role);
        msg.setContent(content);
        if (citations != null) {
            msg.setCitations(mapper.valueToTree(citations));
        }
        messages.save(msg);
        return ChatMessageResponse.from(msg);
    }

    private ChatConversation ownedConversation(String userId, String conversationId) {
        return conversations.findByIdAndUserId(conversationId, userId)
                // Same answer as for one that never existed, so a 404 never
                // confirms somebody else's thread is there.
                .orElseThrow(() -> ApiException.notFound("Conversation not found"));
    }

    /**
     * Refuse a conversation from the wrong scope.
     *
     * <p>Without this, a meeting chat handed a workspace conversation id would
     * answer from one meeting and file the turn under the workspace thread,
     * where it would later be read back as a cross-meeting answer.
     */
    private ChatConversation requireScoped(ChatConversation c, String meetingId) {
        boolean matches = meetingId == null
                ? c.getMeetingId() == null
                : meetingId.equals(c.getMeetingId());
        if (!matches) {
            throw ApiException.notFound("Conversation not found");
        }
        return c;
    }

    private void requireOwnedMeeting(String userId, String meetingId) {
        meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));
    }
}
