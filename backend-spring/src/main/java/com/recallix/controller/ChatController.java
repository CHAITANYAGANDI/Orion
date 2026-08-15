package com.recallix.controller;

import com.recallix.dto.ChatAskRequest;
import com.recallix.dto.ChatMessageResponse;
import com.recallix.dto.ConversationRenameRequest;
import com.recallix.dto.ConversationResponse;
import com.recallix.dto.EmailDraftResponse;
import com.recallix.dto.ExchangeDeleteResponse;
import com.recallix.dto.TranslateRequest;
import com.recallix.dto.TranslateResponse;
import com.recallix.dto.WorkspaceAskRequest;
import com.recallix.security.SecurityUtils;
import com.recallix.service.ChatService;
import com.recallix.service.FollowUpService;
import com.recallix.service.TranslationService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * RAG chat at two scopes — one meeting, or the whole workspace — plus summary
 * translation.
 *
 * <p>Both scopes are organised into named conversations (V28). The scope is
 * carried in the path for a meeting and by its absence for the workspace, which
 * is the shape the two chats already had; conversations hang off whichever one
 * you are in.
 */
@RestController
public class ChatController {

    private final ChatService chat;
    private final TranslationService translation;
    private final FollowUpService followUp;

    public ChatController(ChatService chat,
                          TranslationService translation,
                          FollowUpService followUp) {
        this.chat = chat;
        this.translation = translation;
        this.followUp = followUp;
    }

    // --- one meeting -------------------------------------------------------- //

    /** A conversation's turns. Without one, whatever was last said here. */
    @GetMapping("/api/v1/meetings/{id}/chat")
    public List<ChatMessageResponse> history(@PathVariable String id,
                                             @RequestParam(required = false) String conversationId) {
        return chat.history(SecurityUtils.currentUserId(), id, conversationId);
    }

    @PostMapping("/api/v1/meetings/{id}/chat")
    public ChatMessageResponse ask(@PathVariable String id, @Valid @RequestBody ChatAskRequest req) {
        return chat.ask(SecurityUtils.currentUserId(), id, req.question(), req.conversationId());
    }

    /** Every conversation about this meeting, most recently used first. */
    @GetMapping("/api/v1/meetings/{id}/chat/conversations")
    public List<ConversationResponse> meetingConversations(@PathVariable String id) {
        return chat.listConversations(SecurityUtils.currentUserId(), id);
    }

    @PostMapping("/api/v1/meetings/{id}/chat/conversations")
    @ResponseStatus(HttpStatus.CREATED)
    public ConversationResponse newMeetingConversation(@PathVariable String id) {
        return chat.createConversation(SecurityUtils.currentUserId(), id);
    }

    /** Every conversation about this meeting, gone. */
    @DeleteMapping("/api/v1/meetings/{id}/chat")
    public ResponseEntity<Void> clearMeetingHistory(@PathVariable String id) {
        chat.clearScope(SecurityUtils.currentUserId(), id);
        return ResponseEntity.noContent().build();
    }

    // --- the workspace ------------------------------------------------------ //

    @GetMapping("/api/v1/chat")
    public List<ChatMessageResponse> workspaceHistory(
            @RequestParam(required = false) String conversationId) {
        return chat.history(SecurityUtils.currentUserId(), null, conversationId);
    }

    @PostMapping("/api/v1/chat")
    public ChatMessageResponse askWorkspace(@Valid @RequestBody WorkspaceAskRequest req) {
        return chat.askWorkspace(SecurityUtils.currentUserId(), req.question(),
                req.meetingIds(), req.conversationId());
    }

    @GetMapping("/api/v1/chat/conversations")
    public List<ConversationResponse> workspaceConversations() {
        return chat.listConversations(SecurityUtils.currentUserId(), null);
    }

    @PostMapping("/api/v1/chat/conversations")
    @ResponseStatus(HttpStatus.CREATED)
    public ConversationResponse newWorkspaceConversation() {
        return chat.createConversation(SecurityUtils.currentUserId(), null);
    }

    @DeleteMapping("/api/v1/chat")
    public ResponseEntity<Void> clearWorkspaceHistory() {
        chat.clearScope(SecurityUtils.currentUserId(), null);
        return ResponseEntity.noContent().build();
    }

    // --- either scope ------------------------------------------------------- //
    // A conversation id already says which chat it belongs to, so renaming and
    // deleting need only one path each rather than one per scope.

    @PatchMapping("/api/v1/chat/conversations/{conversationId}")
    public ConversationResponse rename(@PathVariable String conversationId,
                                       @Valid @RequestBody ConversationRenameRequest req) {
        return chat.renameConversation(SecurityUtils.currentUserId(), conversationId, req.title());
    }

    @DeleteMapping("/api/v1/chat/conversations/{conversationId}")
    public ResponseEntity<Void> deleteConversation(@PathVariable String conversationId) {
        chat.deleteConversation(SecurityUtils.currentUserId(), conversationId);
        return ResponseEntity.noContent().build();
    }

    /**
     * Remove one exchange — the message named and the turn that goes with it.
     *
     * <p>Returns a body rather than a 204 because deleting the last exchange
     * also deletes the thread, and the caller is holding that thread's id. A
     * 204 left it with no way to know, so its next read asked for a
     * conversation that no longer existed and the chat locked up on 404s.
     */
    @DeleteMapping("/api/v1/chat/messages/{messageId}")
    public ExchangeDeleteResponse deleteExchange(@PathVariable String messageId) {
        return chat.deleteExchange(SecurityUtils.currentUserId(), messageId);
    }

    // --- other per-meeting AI actions --------------------------------------- //

    @PostMapping("/api/v1/meetings/{id}/translate")
    public TranslateResponse translate(@PathVariable String id, @Valid @RequestBody TranslateRequest req) {
        return translation.translateSummary(SecurityUtils.currentUserId(), id, req.targetLanguage());
    }

    /** Draft the recap email for this meeting, grounded in its brief. */
    @PostMapping("/api/v1/meetings/{id}/follow-up-email")
    public EmailDraftResponse followUpEmail(@PathVariable String id) {
        return followUp.draft(SecurityUtils.currentUserId(), id);
    }
}
