package com.recallix.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.recallix.common.ApiException;
import com.recallix.common.ConversationTitle;
import com.recallix.domain.ChatMode;
import com.recallix.domain.ChatScope;
import com.recallix.dto.ChatMessageResponse;
import com.recallix.dto.ExchangeDeleteResponse;
import com.recallix.entity.ChatConversation;
import com.recallix.entity.ChatMessage;
import com.recallix.entity.Meeting;
import com.recallix.entity.Project;
import com.recallix.repository.ChatConversationRepository;
import com.recallix.repository.ChatMessageRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.ProjectRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Chat organised into named conversations.
 *
 * <p>Two failure modes are worth more than the rest. The first is a turn filed
 * under the wrong thread — it answers correctly, saves cleanly, and then
 * reappears inside an unrelated conversation, which makes the history actively
 * misleading rather than merely untidy. The second is deleting one exchange and
 * taking a neighbouring one with it: silent, total, and the user has no other
 * copy.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ChatConversationTest {

    private static final String USER = "usr_1";
    private static final String OTHER = "usr_2";
    private static final String MEETING = "mtg_1";
    private static final String PROJECT = "prj_1";

    /** The three scopes, named once so the tests read as English. */
    private static final ChatScope MTG = ChatScope.meeting(MEETING);
    private static final ChatScope PRJ = ChatScope.project(PROJECT);
    private static final ChatScope WS = ChatScope.WORKSPACE;

    @Mock private ChatMessageRepository messages;
    @Mock private ChatConversationRepository conversations;
    @Mock private MeetingRepository meetings;
    @Mock private ProjectRepository projects;
    @Mock private AiClient ai;
    @Mock private UserService users;
    @Mock private UsageLimitService usage;

    private ChatService service;
    private final List<ChatConversation> stored = new ArrayList<>();
    private final List<ChatMessage> turns = new ArrayList<>();

    @BeforeEach
    void setUp() {
        service = new ChatService(messages, conversations, meetings, projects, ai, users, usage,
                new ObjectMapper());
        when(users.require(anyString())).thenReturn(new com.recallix.entity.UserEntity());
        stored.clear();
        turns.clear();

        Meeting m = new Meeting();
        m.setId(MEETING);
        m.setUserId(USER);
        when(meetings.findByIdAndUserId(anyString(), anyString())).thenAnswer(inv ->
                USER.equals(inv.getArgument(1)) ? Optional.of(m) : Optional.empty());

        when(ai.chat(anyString(), anyString(), anyString(), any(ChatMode.class), any()))
                .thenReturn(new AiClient.ChatResult("An answer.", List.of()));
        when(ai.workspaceChat(anyString(), anyString(), any(), any(), any(), any()))
                .thenReturn(new AiClient.ChatResult("An answer.", List.of()));

        when(conversations.save(any())).thenAnswer(inv -> {
            ChatConversation c = inv.getArgument(0);
            stored.add(c);
            return c;
        });
        when(conversations.findByIdAndUserId(anyString(), anyString())).thenAnswer(inv ->
                stored.stream()
                        .filter(c -> c.getId().equals(inv.getArgument(0))
                                && c.getUserId().equals(inv.getArgument(1)))
                        .findFirst());
        when(conversations.findFirstByUserIdAndMeetingIdOrderByUpdatedAtDesc(anyString(), anyString()))
                .thenAnswer(inv -> scope(ChatScope.meeting(inv.getArgument(1))).stream().findFirst());
        when(conversations.findFirstByUserIdAndProjectIdOrderByUpdatedAtDesc(anyString(), anyString()))
                .thenAnswer(inv -> scope(ChatScope.project(inv.getArgument(1))).stream().findFirst());
        when(conversations.findFirstByUserIdAndMeetingIdIsNullAndProjectIdIsNullOrderByUpdatedAtDesc(anyString()))
                .thenAnswer(inv -> scope(WS).stream().findFirst());
        when(conversations.findByUserIdAndMeetingIdOrderByUpdatedAtDesc(anyString(), anyString()))
                .thenAnswer(inv -> scope(ChatScope.meeting(inv.getArgument(1))));
        when(conversations.findByUserIdAndProjectIdOrderByUpdatedAtDesc(anyString(), anyString()))
                .thenAnswer(inv -> scope(ChatScope.project(inv.getArgument(1))));
        when(conversations.findByUserIdAndMeetingIdIsNullAndProjectIdIsNullOrderByUpdatedAtDesc(anyString()))
                .thenAnswer(inv -> scope(WS));

        Project p = new Project();
        p.setId(PROJECT);
        p.setUserId(USER);
        p.setName("Recallix Development");
        when(projects.findByIdAndUserId(anyString(), anyString())).thenAnswer(inv ->
                USER.equals(inv.getArgument(1)) ? Optional.of(p) : Optional.empty());
        when(meetings.findIdsByUserIdAndProjectId(anyString(), anyString()))
                .thenReturn(List.of(MEETING));

        when(messages.save(any())).thenAnswer(inv -> {
            ChatMessage msg = inv.getArgument(0);
            msg.setCreatedAt(Instant.now().plusMillis(turns.size()));
            turns.add(msg);
            return msg;
        });
        when(messages.findByConversationIdOrderByCreatedAtAsc(anyString())).thenAnswer(inv ->
                turns.stream().filter(t -> inv.getArgument(0).equals(t.getConversationId())).toList());
        when(messages.findByIdAndUserId(anyString(), anyString())).thenAnswer(inv ->
                turns.stream()
                        .filter(t -> t.getId().equals(inv.getArgument(0))
                                && t.getUserId().equals(inv.getArgument(1)))
                        .findFirst());
        when(messages.countByConversationId(anyString())).thenAnswer(inv ->
                turns.stream().filter(t -> inv.getArgument(0).equals(t.getConversationId())).count());
    }

    /** Conversations at one scope, newest first — what the real query returns. */
    private List<ChatConversation> scope(ChatScope scope) {
        return stored.stream()
                .filter(c -> scope.holds(c.getMeetingId(), c.getProjectId()))
                .sorted((a, b) -> b.getUpdatedAt().compareTo(a.getUpdatedAt()))
                .toList();
    }

    private ChatConversation existing(String id, ChatScope scope, String title, Instant updated) {
        ChatConversation c = new ChatConversation();
        c.setId(id);
        c.setUserId(USER);
        c.setMeetingId(scope.meetingId());
        c.setProjectId(scope.projectId());
        c.setTitle(title);
        c.setUpdatedAt(updated);
        stored.add(c);
        return c;
    }

    // --- starting and naming ------------------------------------------------- //
    @Nested
    class Naming {

        @Test
        @DisplayName("the first question names the thread")
        void firstQuestionNames() {
            service.ask(USER, MEETING, "What are the action items from last week?", null, ChatMode.EXPRESS);
            assertThat(stored).hasSize(1);
            assertThat(stored.get(0).getTitle()).isEqualTo("Action items from last week");
        }

        @Test
        @DisplayName("later questions do not rename it")
        void laterQuestionsDoNotRename() {
            service.ask(USER, MEETING, "What are the action items?", null, ChatMode.EXPRESS);
            String named = stored.get(0).getTitle();
            service.ask(USER, MEETING, "And who owns the second one?", null, ChatMode.EXPRESS);

            // A thread that renamed itself on every message would be
            // unfindable — the row would move and change under the reader.
            assertThat(stored.get(0).getTitle()).isEqualTo(named);
        }

        @Test
        @DisplayName("a question never overwrites a name the user chose")
        void doesNotOverwriteAManualName() {
            ChatConversation c = existing("cnv_1", MTG, "Renewal risks", Instant.now());

            service.ask(USER, MEETING, "What are the next steps?", "cnv_1", ChatMode.EXPRESS);

            assertThat(c.getTitle()).isEqualTo("Renewal risks");
        }

        @Test
        @DisplayName("an empty conversation created up front is named by its first question")
        void emptyThenNamed() {
            String id = service.createConversation(USER, MTG).id();
            assertThat(stored.get(0).getTitle()).isEqualTo(ConversationTitle.UNTITLED);

            service.ask(USER, MEETING, "What are the open risks?", id, ChatMode.EXPRESS);

            assertThat(stored.get(0).getTitle()).isEqualTo("Open risks");
        }
    }

    // --- which thread a turn lands in ---------------------------------------- //
    /**
     * Express and Advanced, on a meeting.
     *
     * <p>The choice was absent here on the recorded ground that one meeting was
     * retrieved in full either way. It is not — retrieval takes the nearest
     * eight passages and a fifteen-minute recording chunks to more than eight —
     * so a long meeting was answered from a sample of itself.
     *
     * <p>What is worth pinning is that the mode survives the trip. It crosses
     * three services to reach the thing it changes, and a mode dropped anywhere
     * along the way fails silently: the answer still arrives, still reads well,
     * and is drawn from a third of the transcript the user asked for.
     */
    @Nested
    class Modes {

        @Test
        @DisplayName("the chosen mode reaches the ai-service")
        void carriesTheMode() {
            service.ask(USER, MEETING, "List everything outstanding", null, ChatMode.ADVANCED);

            verify(ai).chat(eq(USER), eq(MEETING), anyString(), eq(ChatMode.ADVANCED), any());
        }

        @Test
        @DisplayName("express is what an unset mode means")
        void defaultsToExpress() {
            // ChatMode.of(null). A client that predates the field — or one that
            // simply does not offer the picker, as the project chat does not —
            // must keep getting exactly the behaviour it got before.
            service.ask(USER, MEETING, "What did we decide?", null, ChatMode.of(null));

            verify(ai).chat(eq(USER), eq(MEETING), anyString(), eq(ChatMode.EXPRESS), any());
        }
    }

    @Nested
    class Routing {

        @Test
        @DisplayName("asking without naming a thread continues the last one")
        void continuesTheLastThread() {
            existing("cnv_old", MTG, "Older", Instant.now().minus(2, ChronoUnit.HOURS));
            existing("cnv_recent", MTG, "Recent", Instant.now().minus(5, ChronoUnit.MINUTES));

            service.ask(USER, MEETING, "Another question?", null, ChatMode.EXPRESS);

            assertThat(turns).allMatch(t -> "cnv_recent".equals(t.getConversationId()));
            assertThat(stored).hasSize(2);
        }

        @Test
        @DisplayName("asking with nothing to continue starts a thread")
        void startsAThread() {
            // A first-time user has no conversation, and the chat box is the
            // primary control — asking must not require picking one first.
            service.ask(USER, MEETING, "First question?", null, ChatMode.EXPRESS);
            assertThat(stored).hasSize(1);
            assertThat(turns).hasSize(2);
        }

        @Test
        @DisplayName("both turns of an exchange land in the same thread")
        void bothTurnsTogether() {
            service.ask(USER, MEETING, "A question?", null, ChatMode.EXPRESS);
            assertThat(turns).extracting(ChatMessage::getConversationId).containsOnly(stored.get(0).getId());
            assertThat(turns).extracting(ChatMessage::getRole).containsExactly("user", "assistant");
        }

        @Test
        @DisplayName("a meeting chat refuses a workspace thread")
        void refusesCrossScope() {
            existing("cnv_ws", WS, "Workspace thread", Instant.now());

            // Accepting it would answer from one meeting and file the turn in
            // the workspace log, where it reads back as a cross-meeting answer.
            assertThatThrownBy(() -> service.ask(USER, MEETING, "A question?", "cnv_ws", ChatMode.EXPRESS))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("Conversation not found");
            assertThat(turns).isEmpty();
        }

        @Test
        @DisplayName("a workspace chat refuses a meeting thread")
        void refusesCrossScopeOtherWay() {
            existing("cnv_mtg", MTG, "Meeting thread", Instant.now());

            assertThatThrownBy(() -> service.askWorkspace(USER, "A question?", null, "cnv_mtg", ChatMode.EXPRESS))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("a meeting's threads are separate from the workspace's")
        void scopesAreSeparate() {
            service.ask(USER, MEETING, "About this meeting?", null, ChatMode.EXPRESS);
            service.askWorkspace(USER, "About everything?", null, null, ChatMode.EXPRESS);

            assertThat(stored).hasSize(2);
            assertThat(service.listConversations(USER, MTG)).hasSize(1);
            assertThat(service.listConversations(USER, WS)).hasSize(1);
        }

        @Test
        @DisplayName("asking bumps the thread to the top")
        void askingBumps() {
            ChatConversation c = existing("cnv_1", MTG, "A thread",
                    Instant.now().minus(3, ChronoUnit.DAYS));

            service.ask(USER, MEETING, "A question?", "cnv_1", ChatMode.EXPRESS);

            assertThat(c.getUpdatedAt()).isAfter(Instant.now().minus(1, ChronoUnit.MINUTES));
        }
    }

    // --- reading ------------------------------------------------------------- //
    @Nested
    class Reading {

        @Test
        @DisplayName("opening a chat shows the thread last used")
        void opensTheLastThread() {
            existing("cnv_old", MTG, "Older", Instant.now().minus(1, ChronoUnit.DAYS));
            ChatConversation recent = existing("cnv_recent", MTG, "Recent", Instant.now());
            ChatMessage msg = new ChatMessage();
            msg.setId("msg_1");
            msg.setUserId(USER);
            msg.setRole("user");
            msg.setContent("hello");
            msg.setConversationId(recent.getId());
            msg.setCreatedAt(Instant.now());
            turns.add(msg);

            assertThat(service.history(USER, MTG, null))
                    .extracting(ChatMessageResponse::content).containsExactly("hello");
        }

        @Test
        @DisplayName("a chat with no threads reads as empty rather than failing")
        void emptyScope() {
            assertThat(service.history(USER, MTG, null)).isEmpty();
            assertThat(service.history(USER, WS, null)).isEmpty();
        }

        @Test
        @DisplayName("the list carries how many turns each thread holds")
        void listCarriesCounts() {
            service.ask(USER, MEETING, "A question?", null, ChatMode.EXPRESS);
            assertThat(service.listConversations(USER, MTG).get(0).messageCount()).isEqualTo(2);
        }

        @Test
        @DisplayName("another user's thread is not found")
        void cannotReadAnotherUsersThread() {
            existing("cnv_1", MTG, "Mine", Instant.now());
            assertThatThrownBy(() -> service.history(OTHER, MTG, "cnv_1"))
                    .isInstanceOf(ApiException.class);
        }
    }

    // --- renaming and deleting ------------------------------------------------ //
    @Nested
    class Managing {

        @Test
        @DisplayName("renaming does not reorder the list")
        void renamingDoesNotBump() {
            Instant was = Instant.now().minus(2, ChronoUnit.DAYS);
            ChatConversation c = existing("cnv_1", MTG, "Old name", was);

            service.renameConversation(USER, "cnv_1", "  Renewal risks  ");

            assertThat(c.getTitle()).isEqualTo("Renewal risks");
            // Tidying is not talking to it; bumping would shuffle the list
            // under somebody who is organising it.
            assertThat(c.getUpdatedAt()).isEqualTo(was);
        }

        @Test
        @DisplayName("a blank name is refused")
        void blankNameRefused() {
            existing("cnv_1", MTG, "Old name", Instant.now());
            assertThatThrownBy(() -> service.renameConversation(USER, "cnv_1", "   "))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("deleting a thread removes it")
        void deletesAThread() {
            ChatConversation c = existing("cnv_1", MTG, "A thread", Instant.now());
            service.deleteConversation(USER, "cnv_1");
            verify(conversations).delete(c);
        }

        @Test
        @DisplayName("another user's thread cannot be deleted")
        void cannotDeleteAnotherUsersThread() {
            existing("cnv_1", MTG, "Mine", Instant.now());
            assertThatThrownBy(() -> service.deleteConversation(OTHER, "cnv_1"))
                    .isInstanceOf(ApiException.class);
            verify(conversations, never()).delete(any());
        }

        @Test
        @DisplayName("clearing a scope removes only that scope's threads")
        void clearingOneScope() {
            existing("cnv_m", MTG, "Meeting thread", Instant.now());
            existing("cnv_w", WS, "Workspace thread", Instant.now());

            service.clearScope(USER, MTG);

            ArgumentCaptor<Iterable<ChatConversation>> captor = ArgumentCaptor.forClass(Iterable.class);
            verify(conversations).deleteAll(captor.capture());
            List<String> ids = new ArrayList<>();
            captor.getValue().forEach(c -> ids.add(c.getId()));
            assertThat(ids).containsExactly("cnv_m");
        }
    }

    // --- deleting one exchange ------------------------------------------------ //
    @Nested
    class DeletingAnExchange {

        private void twoExchanges() {
            service.ask(USER, MEETING, "First question?", null, ChatMode.EXPRESS);
            service.ask(USER, MEETING, "Second question?", null, ChatMode.EXPRESS);
        }

        @Test
        @DisplayName("deleting a question takes its answer")
        void takesTheAnswer() {
            service.ask(USER, MEETING, "A question?", null, ChatMode.EXPRESS);
            String questionId = turns.get(0).getId();

            assertThat(service.deleteExchange(USER, questionId).deletedMessages()).isEqualTo(2);
        }

        @Test
        @DisplayName("deleting an answer takes its question")
        void takesTheQuestion() {
            service.ask(USER, MEETING, "A question?", null, ChatMode.EXPRESS);
            String answerId = turns.get(1).getId();

            assertThat(service.deleteExchange(USER, answerId).deletedMessages()).isEqualTo(2);
        }

        @Test
        @DisplayName("the neighbouring exchange survives")
        void neighboursSurvive() {
            twoExchanges();
            String secondQuestion = turns.get(2).getId();

            service.deleteExchange(USER, secondQuestion);

            ArgumentCaptor<Iterable<ChatMessage>> captor = ArgumentCaptor.forClass(Iterable.class);
            verify(messages).deleteAll(captor.capture());
            List<String> ids = new ArrayList<>();
            captor.getValue().forEach(m -> ids.add(m.getId()));
            // Walking one turn too far silently eats a conversation the user
            // has no other copy of.
            assertThat(ids).containsExactlyInAnyOrder(secondQuestion, turns.get(3).getId());
        }

        @Test
        @DisplayName("pairing does not reach into another thread")
        void pairingStaysInsideItsThread() {
            // Two threads written interleaved. Pairing across the scope rather
            // than the conversation would join a question in one to an answer
            // in the other.
            String a = service.createConversation(USER, MTG).id();
            String b = service.createConversation(USER, MTG).id();
            service.ask(USER, MEETING, "In A?", a, ChatMode.EXPRESS);
            service.ask(USER, MEETING, "In B?", b, ChatMode.EXPRESS);

            service.deleteExchange(USER, turns.get(0).getId());

            ArgumentCaptor<Iterable<ChatMessage>> captor = ArgumentCaptor.forClass(Iterable.class);
            verify(messages).deleteAll(captor.capture());
            captor.getValue().forEach(m -> assertThat(m.getConversationId()).isEqualTo(a));
        }

        @Test
        @DisplayName("emptying a thread removes the thread, and says so")
        void emptyingRemovesTheThread() {
            service.ask(USER, MEETING, "The only question?", null, ChatMode.EXPRESS);

            ExchangeDeleteResponse result = service.deleteExchange(USER, turns.get(0).getId());

            // Otherwise the history list keeps a row that opens onto nothing.
            verify(conversations).delete(any());
            // And the caller — which is holding this conversation's id in state
            // — has to be told, or every request it makes next will 404 and the
            // chat will look like it broke rather than like it emptied.
            assertThat(result.conversationDeleted()).isTrue();
        }

        @Test
        @DisplayName("emptying one exchange of two leaves the thread alone")
        void partialDeleteKeepsTheThread() {
            twoExchanges();

            ExchangeDeleteResponse result = service.deleteExchange(USER, turns.get(0).getId());

            verify(conversations, never()).delete(any());
            // The caller must keep its id here — resetting would jump the user
            // out of the thread they are reading.
            assertThat(result.conversationDeleted()).isFalse();
        }

        @Test
        @DisplayName("another user's message is not found")
        void cannotDeleteAnotherUsersMessage() {
            service.ask(USER, MEETING, "A question?", null, ChatMode.EXPRESS);
            assertThatThrownBy(() -> service.deleteExchange(OTHER, turns.get(0).getId()))
                    .isInstanceOf(ApiException.class);
            verify(messages, never()).deleteAll(any());
        }
    }

    // --- asking a project --------------------------------------------------- //

    /**
     * The third scope.
     *
     * <p>Everything here is about keeping it separate from the workspace. Before
     * V30 "the workspace" meant "no meeting id", and a project thread has no
     * meeting id either — so the two would have shared a history, and clearing
     * one would have deleted the other.
     */
    @Nested
    class AskingAProject {

        @Test
        @DisplayName("a project question reads only that project's meetings")
        void retrievalIsNarrowedToTheProject() {
            when(meetings.findIdsByUserIdAndProjectId(USER, PROJECT))
                    .thenReturn(List.of("mtg_a", "mtg_b"));

            service.askProject(USER, PROJECT, "What did we decide?", null);

            // Resolved here rather than accepted from the caller: what a project
            // contains is a fact about the database, not a client's assertion.
            verify(ai).workspaceChat(eq(USER), eq("What did we decide?"),
                    eq(List.of("mtg_a", "mtg_b")), eq(ChatMode.EXPRESS), isNull(), any());
        }

        @Test
        @DisplayName("an empty project is answered without a model call")
        void emptyProjectShortCircuits() {
            when(meetings.findIdsByUserIdAndProjectId(USER, PROJECT)).thenReturn(List.of());

            ChatMessageResponse answer =
                    service.askProject(USER, PROJECT, "What did we decide?", null);

            // An empty id list means "do not filter" downstream, so sending one
            // would answer a question about this project from every meeting in
            // the workspace and present it as the project's.
            verify(ai, never()).workspaceChat(anyString(), anyString(), any(), any(), any(), any());
            assertThat(answer.content()).isEqualTo(ChatService.EMPTY_PROJECT);
        }

        @Test
        @DisplayName("an empty project still keeps the exchange")
        void emptyProjectStillRecordsTheTurn() {
            when(meetings.findIdsByUserIdAndProjectId(USER, PROJECT)).thenReturn(List.of());

            service.askProject(USER, PROJECT, "What did we decide?", null);

            assertThat(turns).hasSize(2);
            assertThat(stored.get(0).getProjectId()).isEqualTo(PROJECT);
            assertThat(stored.get(0).getMeetingId()).isNull();
        }

        @Test
        @DisplayName("the first question names the project thread too")
        void firstQuestionNamesIt() {
            service.askProject(USER, PROJECT, "What are the open risks?", null);
            assertThat(stored.get(0).getTitle()).isEqualTo("Open risks");
        }

        @Test
        @DisplayName("project threads are not in the workspace history")
        void projectThreadsAreNotWorkspaceThreads() {
            service.askProject(USER, PROJECT, "About this project?", null);
            service.askWorkspace(USER, "About everything?", null, null, ChatMode.EXPRESS);

            assertThat(service.listConversations(USER, PRJ)).hasSize(1);
            assertThat(service.listConversations(USER, WS)).hasSize(1);
        }

        @Test
        @DisplayName("clearing the workspace chat leaves project threads alone")
        void clearingTheWorkspaceSparesProjects() {
            existing("cnv_prj", PRJ, "Project thread", Instant.now());
            existing("cnv_ws", WS, "Workspace thread", Instant.now());

            service.clearScope(USER, WS);

            // The whole reason the scope is a value and not a nullable id: both
            // of these have no meeting, and the old query would have taken both.
            ArgumentCaptor<Iterable<ChatConversation>> deleted = ArgumentCaptor.captor();
            verify(conversations).deleteAll(deleted.capture());
            assertThat(deleted.getValue()).extracting(ChatConversation::getId)
                    .containsExactly("cnv_ws");
        }

        @Test
        @DisplayName("a workspace thread cannot be continued as a project thread")
        void refusesAConversationFromAnotherScope() {
            existing("cnv_ws", WS, "Workspace thread", Instant.now());

            assertThatThrownBy(() -> service.askProject(USER, PROJECT, "A question?", "cnv_ws"))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("another user's project is not found")
        void cannotAskSomebodyElsesProject() {
            assertThatThrownBy(() -> service.askProject(OTHER, PROJECT, "A question?", null))
                    .isInstanceOf(ApiException.class);
            verify(ai, never()).workspaceChat(anyString(), anyString(), any(), any(), any(), any());
        }
    }
}

