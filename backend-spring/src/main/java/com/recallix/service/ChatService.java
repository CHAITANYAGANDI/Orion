package com.recallix.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.recallix.common.ApiException;
import com.recallix.common.ConversationTitle;
import com.recallix.common.IdGenerator;
import com.recallix.domain.ChatMode;
import com.recallix.domain.ChatScope;
import com.recallix.dto.ChatMessageResponse;
import com.recallix.dto.ConversationResponse;
import com.recallix.dto.ExchangeDeleteResponse;
import com.recallix.entity.ChatConversation;
import com.recallix.entity.ChatMessage;
import com.recallix.repository.ChatConversationRepository;
import com.recallix.repository.ChatMessageRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.ProjectRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * RAG chat at three scopes — one meeting, one project, or the whole workspace —
 * organised into named conversations.
 *
 * <p>Before V28 each scope was one unbounded thread, which made "clear it all"
 * the only way to tidy up and therefore the thing people did. A conversation is
 * the unit somebody actually means: a question and its follow-ups, keepable or
 * discardable on its own.
 *
 * <p>V30 added the project scope, and with it {@link ChatScope}: two scopes fit
 * into a nullable meeting id, three do not. See that record for what breaks if
 * "the workspace" and "a project" are both spelled "no meeting".
 */
@Service
public class ChatService {

    private final ChatMessageRepository messages;
    private final ChatConversationRepository conversations;
    private final MeetingRepository meetings;
    private final ProjectRepository projects;
    private final AiClient ai;
    private final ObjectMapper mapper;

    public ChatService(ChatMessageRepository messages,
                       ChatConversationRepository conversations,
                       MeetingRepository meetings,
                       ProjectRepository projects,
                       AiClient ai,
                       ObjectMapper mapper) {
        this.messages = messages;
        this.conversations = conversations;
        this.meetings = meetings;
        this.projects = projects;
        this.ai = ai;
        this.mapper = mapper;
    }

    /**
     * The answer for a project with nothing in it.
     *
     * <p>Says what is missing and what to do, rather than "I don't know" — the
     * user has just created a project and is finding out what it does, and a
     * blank refusal at that moment reads as a broken feature.
     */
    static final String EMPTY_PROJECT =
            "There are no meetings in this project yet, so there is nothing for me to read. "
            + "Add meetings to it and ask again.";

    // --- conversations ------------------------------------------------------ //

    /** Every conversation at one scope, most recently spoken to first. */
    @Transactional(readOnly = true)
    public List<ConversationResponse> listConversations(String userId, ChatScope scope) {
        requireOwnedScope(userId, scope);
        return scopeConversations(userId, scope).stream()
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
    public ConversationResponse createConversation(String userId, ChatScope scope) {
        requireOwnedScope(userId, scope);
        return ConversationResponse.from(newConversation(userId, scope), 0);
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
    public void clearScope(String userId, ChatScope scope) {
        requireOwnedScope(userId, scope);
        conversations.deleteAll(scopeConversations(userId, scope));
    }

    // --- reading ------------------------------------------------------------ //

    /**
     * One conversation's turns.
     *
     * <p>A null {@code conversationId} means "whatever I was last saying here",
     * which is what opening a chat should show. Empty when there is nothing yet.
     */
    @Transactional(readOnly = true)
    public List<ChatMessageResponse> history(String userId, ChatScope scope, String conversationId) {
        requireOwnedScope(userId, scope);
        Optional<ChatConversation> target = conversationId == null
                ? mostRecent(userId, scope)
                : Optional.of(requireScoped(ownedConversation(userId, conversationId), scope));

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
        ChatScope scope = ChatScope.meeting(meetingId);
        ChatConversation conversation = resolveForAsk(userId, scope, conversationId);

        persistTurn(userId, meetingId, conversation, "user", question, null);
        AiClient.ChatResult result = ai.chat(userId, meetingId, question);
        ChatMessageResponse answer = persistTurn(userId, meetingId, conversation, "assistant",
                result.answer() == null ? "" : result.answer(), result.citations());

        touch(conversation, question);
        return answer;
    }

    /**
     * Ask a question of one project — the reason projects exist.
     *
     * <p>Retrieval is the workspace search narrowed to this project's meetings,
     * which is why the id list is resolved here rather than passed in: what the
     * project contains is a fact about the database at the moment the question
     * is asked, not something a client should be able to assert.
     *
     * <p><b>The empty project is answered without a model call.</b> Downstream,
     * an empty id list means "do not filter" — so handing one over would answer
     * a question about this project from every meeting in the workspace, and
     * present it as though the project had said it. Deliberately not an error
     * either: an empty project is a normal state, usually the one right after
     * creating it.
     */
    @Transactional
    public ChatMessageResponse askProject(String userId, String projectId, String question,
                                          String conversationId) {
        ChatScope scope = ChatScope.project(projectId);
        requireOwnedScope(userId, scope);
        ChatConversation conversation = resolveForAsk(userId, scope, conversationId);
        List<String> meetingIds = meetings.findIdsByUserIdAndProjectId(userId, projectId);

        persistTurn(userId, null, conversation, "user", question, null);
        ChatMessageResponse answer = meetingIds.isEmpty()
                ? persistTurn(userId, null, conversation, "assistant", EMPTY_PROJECT, null)
                : answerFromMeetings(userId, conversation, question, meetingIds);

        touch(conversation, question);
        return answer;
    }

    private ChatMessageResponse answerFromMeetings(String userId, ChatConversation conversation,
                                                   String question, List<String> meetingIds) {
        // A project chat has no mode picker, so it takes the default. The choice
        // belongs to the composer that offers it.
        AiClient.ChatResult result = ai.workspaceChat(
                userId, question, meetingIds, ChatMode.EXPRESS);
        return persistTurn(userId, null, conversation, "assistant",
                result.answer() == null ? "" : result.answer(), result.citations());
    }

    /**
     * Ask a question grounded across every meeting the user owns. No ownership
     * check is needed for retrieval: the ai-service filters by userId, so the
     * answer can only ever be grounded in this user's transcripts.
     */
    @Transactional
    public ChatMessageResponse askWorkspace(String userId, String question,
                                            List<String> meetingIds, String conversationId,
                                            ChatMode mode) {
        // If the caller narrowed the search, verify they own what they named.
        // This is also the check behind the composer's "Add context": the ids
        // arrive from a picker, and a picker is a client-side control.
        if (meetingIds != null) {
            meetingIds.forEach(id -> requireOwnedMeeting(userId, id));
        }
        ChatConversation conversation = resolveForAsk(userId, ChatScope.WORKSPACE, conversationId);

        persistTurn(userId, null, conversation, "user", question, null);
        AiClient.ChatResult result = ai.workspaceChat(userId, question, meetingIds, mode);
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
     * @return what was removed, including whether the thread went with it —
     *         see {@link ExchangeDeleteResponse} for why that matters.
     */
    @Transactional
    public ExchangeDeleteResponse deleteExchange(String userId, String messageId) {
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
        // history list that opens onto nothing. Reported back rather than done
        // silently: the caller is almost certainly holding this conversation's
        // id, and every request it makes afterwards would 404.
        boolean conversationDeleted = false;
        if (doomed.size() >= thread.size()) {
            Optional<ChatConversation> emptied =
                    conversations.findByIdAndUserId(target.getConversationId(), userId);
            emptied.ifPresent(conversations::delete);
            conversationDeleted = emptied.isPresent();
        }
        return new ExchangeDeleteResponse(doomed.size(), conversationDeleted);
    }

    // --- helpers ------------------------------------------------------------ //

    private List<ChatConversation> scopeConversations(String userId, ChatScope scope) {
        if (scope.isMeeting()) {
            return conversations.findByUserIdAndMeetingIdOrderByUpdatedAtDesc(userId, scope.meetingId());
        }
        if (scope.isProject()) {
            return conversations.findByUserIdAndProjectIdOrderByUpdatedAtDesc(userId, scope.projectId());
        }
        return conversations.findByUserIdAndMeetingIdIsNullAndProjectIdIsNullOrderByUpdatedAtDesc(userId);
    }

    private Optional<ChatConversation> mostRecent(String userId, ChatScope scope) {
        if (scope.isMeeting()) {
            return conversations.findFirstByUserIdAndMeetingIdOrderByUpdatedAtDesc(userId, scope.meetingId());
        }
        if (scope.isProject()) {
            return conversations.findFirstByUserIdAndProjectIdOrderByUpdatedAtDesc(userId, scope.projectId());
        }
        return conversations.findFirstByUserIdAndMeetingIdIsNullAndProjectIdIsNullOrderByUpdatedAtDesc(userId);
    }

    /**
     * The conversation a question belongs to: the one named, the one last used,
     * or a new one. Asking without naming a thread must never fail — the chat
     * box is the primary control and a first-time user has no conversation yet.
     */
    private ChatConversation resolveForAsk(String userId, ChatScope scope, String conversationId) {
        if (conversationId != null) {
            return requireScoped(ownedConversation(userId, conversationId), scope);
        }
        return mostRecent(userId, scope).orElseGet(() -> newConversation(userId, scope));
    }

    private ChatConversation newConversation(String userId, ChatScope scope) {
        ChatConversation c = new ChatConversation();
        c.setId(IdGenerator.conversation());
        c.setUserId(userId);
        c.setMeetingId(scope.meetingId());
        c.setProjectId(scope.projectId());
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
     * where it would later be read back as a cross-meeting answer. With three
     * scopes there is one more way to get this wrong — a project thread and a
     * workspace thread differ only by a column that is null in one of them.
     */
    private ChatConversation requireScoped(ChatConversation c, ChatScope scope) {
        if (!scope.holds(c.getMeetingId(), c.getProjectId())) {
            throw ApiException.notFound("Conversation not found");
        }
        return c;
    }

    /**
     * Whatever the scope names has to belong to the caller.
     *
     * <p>The workspace scope names nothing, so there is nothing to check: the
     * ai-service filters retrieval by user id, and every query here is written
     * against the caller's own rows.
     */
    private void requireOwnedScope(String userId, ChatScope scope) {
        if (scope.isMeeting()) {
            requireOwnedMeeting(userId, scope.meetingId());
        } else if (scope.isProject()) {
            projects.findByIdAndUserId(scope.projectId(), userId)
                    .orElseThrow(() -> ApiException.notFound("Project not found"));
        }
    }

    private void requireOwnedMeeting(String userId, String meetingId) {
        meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));
    }
}
