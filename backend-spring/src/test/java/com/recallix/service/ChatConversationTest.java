package com.recallix.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.recallix.common.ApiException;
import com.recallix.common.ConversationTitle;
import com.recallix.dto.ChatMessageResponse;
import com.recallix.entity.ChatConversation;
import com.recallix.entity.ChatMessage;
import com.recallix.entity.Meeting;
import com.recallix.repository.ChatConversationRepository;
import com.recallix.repository.ChatMessageRepository;
import com.recallix.repository.MeetingRepository;
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
import static org.mockito.ArgumentMatchers.anyString;
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

    @Mock private ChatMessageRepository messages;
    @Mock private ChatConversationRepository conversations;
    @Mock private MeetingRepository meetings;
    @Mock private AiClient ai;

    private ChatService service;
    private final List<ChatConversation> stored = new ArrayList<>();
    private final List<ChatMessage> turns = new ArrayList<>();

    @BeforeEach
    void setUp() {
        service = new ChatService(messages, conversations, meetings, ai, new ObjectMapper());
        stored.clear();
        turns.clear();

        Meeting m = new Meeting();
        m.setId(MEETING);
        m.setUserId(USER);
        when(meetings.findByIdAndUserId(anyString(), anyString())).thenAnswer(inv ->
                USER.equals(inv.getArgument(1)) ? Optional.of(m) : Optional.empty());

        when(ai.chat(anyString(), anyString(), anyString()))
                .thenReturn(new AiClient.ChatResult("An answer.", List.of()));
        when(ai.workspaceChat(anyString(), anyString(), any()))
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
                .thenAnswer(inv -> scope(inv.getArgument(1)).stream().findFirst());
        when(conversations.findFirstByUserIdAndMeetingIdIsNullOrderByUpdatedAtDesc(anyString()))
                .thenAnswer(inv -> scope(null).stream().findFirst());
        when(conversations.findByUserIdAndMeetingIdOrderByUpdatedAtDesc(anyString(), anyString()))
                .thenAnswer(inv -> scope(inv.getArgument(1)));
        when(conversations.findByUserIdAndMeetingIdIsNullOrderByUpdatedAtDesc(anyString()))
                .thenAnswer(inv -> scope(null));

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
    private List<ChatConversation> scope(String meetingId) {
        return stored.stream()
                .filter(c -> meetingId == null ? c.getMeetingId() == null : meetingId.equals(c.getMeetingId()))
                .sorted((a, b) -> b.getUpdatedAt().compareTo(a.getUpdatedAt()))
                .toList();
    }

    private ChatConversation existing(String id, String meetingId, String title, Instant updated) {
        ChatConversation c = new ChatConversation();
        c.setId(id);
        c.setUserId(USER);
        c.setMeetingId(meetingId);
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
            service.ask(USER, MEETING, "What are the action items from last week?", null);
            assertThat(stored).hasSize(1);
            assertThat(stored.get(0).getTitle()).isEqualTo("Action items from last week");
        }

        @Test
        @DisplayName("later questions do not rename it")
        void laterQuestionsDoNotRename() {
            service.ask(USER, MEETING, "What are the action items?", null);
            String named = stored.get(0).getTitle();
            service.ask(USER, MEETING, "And who owns the second one?", null);

            // A thread that renamed itself on every message would be
            // unfindable — the row would move and change under the reader.
            assertThat(stored.get(0).getTitle()).isEqualTo(named);
        }

        @Test
        @DisplayName("a question never overwrites a name the user chose")
        void doesNotOverwriteAManualName() {
            ChatConversation c = existing("cnv_1", MEETING, "Renewal risks", Instant.now());

            service.ask(USER, MEETING, "What are the next steps?", "cnv_1");

            assertThat(c.getTitle()).isEqualTo("Renewal risks");
        }

        @Test
        @DisplayName("an empty conversation created up front is named by its first question")
        void emptyThenNamed() {
            String id = service.createConversation(USER, MEETING).id();
            assertThat(stored.get(0).getTitle()).isEqualTo(ConversationTitle.UNTITLED);

            service.ask(USER, MEETING, "What are the open risks?", id);

            assertThat(stored.get(0).getTitle()).isEqualTo("Open risks");
        }
    }

    // --- which thread a turn lands in ---------------------------------------- //
    @Nested
    class Routing {

        @Test
        @DisplayName("asking without naming a thread continues the last one")
        void continuesTheLastThread() {
            existing("cnv_old", MEETING, "Older", Instant.now().minus(2, ChronoUnit.HOURS));
            existing("cnv_recent", MEETING, "Recent", Instant.now().minus(5, ChronoUnit.MINUTES));

            service.ask(USER, MEETING, "Another question?", null);

            assertThat(turns).allMatch(t -> "cnv_recent".equals(t.getConversationId()));
            assertThat(stored).hasSize(2);
        }

        @Test
        @DisplayName("asking with nothing to continue starts a thread")
        void startsAThread() {
            // A first-time user has no conversation, and the chat box is the
            // primary control — asking must not require picking one first.
            service.ask(USER, MEETING, "First question?", null);
            assertThat(stored).hasSize(1);
            assertThat(turns).hasSize(2);
        }

        @Test
        @DisplayName("both turns of an exchange land in the same thread")
        void bothTurnsTogether() {
            service.ask(USER, MEETING, "A question?", null);
            assertThat(turns).extracting(ChatMessage::getConversationId).containsOnly(stored.get(0).getId());
            assertThat(turns).extracting(ChatMessage::getRole).containsExactly("user", "assistant");
        }

        @Test
        @DisplayName("a meeting chat refuses a workspace thread")
        void refusesCrossScope() {
            existing("cnv_ws", null, "Workspace thread", Instant.now());

            // Accepting it would answer from one meeting and file the turn in
            // the workspace log, where it reads back as a cross-meeting answer.
            assertThatThrownBy(() -> service.ask(USER, MEETING, "A question?", "cnv_ws"))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("Conversation not found");
            assertThat(turns).isEmpty();
        }

        @Test
        @DisplayName("a workspace chat refuses a meeting thread")
        void refusesCrossScopeOtherWay() {
            existing("cnv_mtg", MEETING, "Meeting thread", Instant.now());

            assertThatThrownBy(() -> service.askWorkspace(USER, "A question?", null, "cnv_mtg"))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("a meeting's threads are separate from the workspace's")
        void scopesAreSeparate() {
            service.ask(USER, MEETING, "About this meeting?", null);
            service.askWorkspace(USER, "About everything?", null, null);

            assertThat(stored).hasSize(2);
            assertThat(service.listConversations(USER, MEETING)).hasSize(1);
            assertThat(service.listConversations(USER, null)).hasSize(1);
        }

        @Test
        @DisplayName("asking bumps the thread to the top")
        void askingBumps() {
            ChatConversation c = existing("cnv_1", MEETING, "A thread",
                    Instant.now().minus(3, ChronoUnit.DAYS));

            service.ask(USER, MEETING, "A question?", "cnv_1");

            assertThat(c.getUpdatedAt()).isAfter(Instant.now().minus(1, ChronoUnit.MINUTES));
        }
    }

    // --- reading ------------------------------------------------------------- //
    @Nested
    class Reading {

        @Test
        @DisplayName("opening a chat shows the thread last used")
        void opensTheLastThread() {
            existing("cnv_old", MEETING, "Older", Instant.now().minus(1, ChronoUnit.DAYS));
            ChatConversation recent = existing("cnv_recent", MEETING, "Recent", Instant.now());
            ChatMessage msg = new ChatMessage();
            msg.setId("msg_1");
            msg.setUserId(USER);
            msg.setRole("user");
            msg.setContent("hello");
            msg.setConversationId(recent.getId());
            msg.setCreatedAt(Instant.now());
            turns.add(msg);

            assertThat(service.history(USER, MEETING, null))
                    .extracting(ChatMessageResponse::content).containsExactly("hello");
        }

        @Test
        @DisplayName("a chat with no threads reads as empty rather than failing")
        void emptyScope() {
            assertThat(service.history(USER, MEETING, null)).isEmpty();
            assertThat(service.history(USER, null, null)).isEmpty();
        }

        @Test
        @DisplayName("the list carries how many turns each thread holds")
        void listCarriesCounts() {
            service.ask(USER, MEETING, "A question?", null);
            assertThat(service.listConversations(USER, MEETING).get(0).messageCount()).isEqualTo(2);
        }

        @Test
        @DisplayName("another user's thread is not found")
        void cannotReadAnotherUsersThread() {
            existing("cnv_1", MEETING, "Mine", Instant.now());
            assertThatThrownBy(() -> service.history(OTHER, MEETING, "cnv_1"))
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
            ChatConversation c = existing("cnv_1", MEETING, "Old name", was);

            service.renameConversation(USER, "cnv_1", "  Renewal risks  ");

            assertThat(c.getTitle()).isEqualTo("Renewal risks");
            // Tidying is not talking to it; bumping would shuffle the list
            // under somebody who is organising it.
            assertThat(c.getUpdatedAt()).isEqualTo(was);
        }

        @Test
        @DisplayName("a blank name is refused")
        void blankNameRefused() {
            existing("cnv_1", MEETING, "Old name", Instant.now());
            assertThatThrownBy(() -> service.renameConversation(USER, "cnv_1", "   "))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("deleting a thread removes it")
        void deletesAThread() {
            ChatConversation c = existing("cnv_1", MEETING, "A thread", Instant.now());
            service.deleteConversation(USER, "cnv_1");
            verify(conversations).delete(c);
        }

        @Test
        @DisplayName("another user's thread cannot be deleted")
        void cannotDeleteAnotherUsersThread() {
            existing("cnv_1", MEETING, "Mine", Instant.now());
            assertThatThrownBy(() -> service.deleteConversation(OTHER, "cnv_1"))
                    .isInstanceOf(ApiException.class);
            verify(conversations, never()).delete(any());
        }

        @Test
        @DisplayName("clearing a scope removes only that scope's threads")
        void clearingOneScope() {
            existing("cnv_m", MEETING, "Meeting thread", Instant.now());
            existing("cnv_w", null, "Workspace thread", Instant.now());

            service.clearScope(USER, MEETING);

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
            service.ask(USER, MEETING, "First question?", null);
            service.ask(USER, MEETING, "Second question?", null);
        }

        @Test
        @DisplayName("deleting a question takes its answer")
        void takesTheAnswer() {
            service.ask(USER, MEETING, "A question?", null);
            String questionId = turns.get(0).getId();

            assertThat(service.deleteExchange(USER, questionId)).isEqualTo(2);
        }

        @Test
        @DisplayName("deleting an answer takes its question")
        void takesTheQuestion() {
            service.ask(USER, MEETING, "A question?", null);
            String answerId = turns.get(1).getId();

            assertThat(service.deleteExchange(USER, answerId)).isEqualTo(2);
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
            String a = service.createConversation(USER, MEETING).id();
            String b = service.createConversation(USER, MEETING).id();
            service.ask(USER, MEETING, "In A?", a);
            service.ask(USER, MEETING, "In B?", b);

            service.deleteExchange(USER, turns.get(0).getId());

            ArgumentCaptor<Iterable<ChatMessage>> captor = ArgumentCaptor.forClass(Iterable.class);
            verify(messages).deleteAll(captor.capture());
            captor.getValue().forEach(m -> assertThat(m.getConversationId()).isEqualTo(a));
        }

        @Test
        @DisplayName("emptying a thread removes the thread")
        void emptyingRemovesTheThread() {
            service.ask(USER, MEETING, "The only question?", null);

            service.deleteExchange(USER, turns.get(0).getId());

            // Otherwise the history list keeps a row that opens onto nothing.
            verify(conversations).delete(any());
        }

        @Test
        @DisplayName("emptying one exchange of two leaves the thread alone")
        void partialDeleteKeepsTheThread() {
            twoExchanges();
            service.deleteExchange(USER, turns.get(0).getId());
            verify(conversations, never()).delete(any());
        }

        @Test
        @DisplayName("another user's message is not found")
        void cannotDeleteAnotherUsersMessage() {
            service.ask(USER, MEETING, "A question?", null);
            assertThatThrownBy(() -> service.deleteExchange(OTHER, turns.get(0).getId()))
                    .isInstanceOf(ApiException.class);
            verify(messages, never()).deleteAll(any());
        }
    }
}
