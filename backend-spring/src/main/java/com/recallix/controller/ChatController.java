package com.recallix.controller;

import com.recallix.domain.ChatMode;
import com.recallix.domain.ChatScope;
import com.recallix.dto.ChatAskRequest;
import com.recallix.dto.ChatMessageResponse;
import com.recallix.dto.ChatModeResponse;
import com.recallix.dto.ConversationRenameRequest;
import com.recallix.dto.ConversationResponse;
import com.recallix.dto.ExchangeDeleteResponse;
import com.recallix.dto.WorkspaceAskRequest;
import com.recallix.security.SecurityUtils;
import com.recallix.service.ChatService;
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
 * RAG chat at three scopes — one meeting, one project, or the whole workspace.
 *
 * <p>All three are organised into named conversations (V28, V30). The scope is
 * carried in the path for a meeting or a project, and by its absence for the
 * workspace; conversations hang off whichever one you are in. Renaming and
 * deleting a conversation stay scope-free, since a conversation id already says
 * which chat it belongs to.
 */
@RestController
public class ChatController {

    private final ChatService chat;
    public ChatController(ChatService chat) {
        this.chat = chat;
    }

    // --- one meeting -------------------------------------------------------- //

    /** A conversation's turns. Without one, whatever was last said here. */
    @GetMapping("/api/v1/meetings/{id}/chat")
    public List<ChatMessageResponse> history(@PathVariable String id,
                                             @RequestParam(required = false) String conversationId) {
        return chat.history(SecurityUtils.currentUserId(), ChatScope.meeting(id), conversationId);
    }

    @PostMapping("/api/v1/meetings/{id}/chat")
    public ChatMessageResponse ask(@PathVariable String id, @Valid @RequestBody ChatAskRequest req) {
        return chat.ask(SecurityUtils.currentUserId(), id, req.question(), req.conversationId(),
                ChatMode.of(req.mode()));
    }

    /** Every conversation about this meeting, most recently used first. */
    @GetMapping("/api/v1/meetings/{id}/chat/conversations")
    public List<ConversationResponse> meetingConversations(@PathVariable String id) {
        return chat.listConversations(SecurityUtils.currentUserId(), ChatScope.meeting(id));
    }

    @PostMapping("/api/v1/meetings/{id}/chat/conversations")
    @ResponseStatus(HttpStatus.CREATED)
    public ConversationResponse newMeetingConversation(@PathVariable String id) {
        return chat.createConversation(SecurityUtils.currentUserId(), ChatScope.meeting(id));
    }

    /** Every conversation about this meeting, gone. */
    @DeleteMapping("/api/v1/meetings/{id}/chat")
    public ResponseEntity<Void> clearMeetingHistory(@PathVariable String id) {
        chat.clearScope(SecurityUtils.currentUserId(), ChatScope.meeting(id));
        return ResponseEntity.noContent().build();
    }

    // --- one project -------------------------------------------------------- //
    // The same four operations as a meeting, against a different scope. The
    // retrieval underneath is the workspace's, narrowed to this project's
    // meetings — see ChatService.askProject.

    @GetMapping("/api/v1/projects/{id}/chat")
    public List<ChatMessageResponse> projectHistory(
            @PathVariable String id,
            @RequestParam(required = false) String conversationId) {
        return chat.history(SecurityUtils.currentUserId(), ChatScope.project(id), conversationId);
    }

    @PostMapping("/api/v1/projects/{id}/chat")
    public ChatMessageResponse askProject(@PathVariable String id,
                                          @Valid @RequestBody ChatAskRequest req) {
        return chat.askProject(SecurityUtils.currentUserId(), id, req.question(), req.conversationId());
    }

    @GetMapping("/api/v1/projects/{id}/chat/conversations")
    public List<ConversationResponse> projectConversations(@PathVariable String id) {
        return chat.listConversations(SecurityUtils.currentUserId(), ChatScope.project(id));
    }

    @PostMapping("/api/v1/projects/{id}/chat/conversations")
    @ResponseStatus(HttpStatus.CREATED)
    public ConversationResponse newProjectConversation(@PathVariable String id) {
        return chat.createConversation(SecurityUtils.currentUserId(), ChatScope.project(id));
    }

    @DeleteMapping("/api/v1/projects/{id}/chat")
    public ResponseEntity<Void> clearProjectHistory(@PathVariable String id) {
        chat.clearScope(SecurityUtils.currentUserId(), ChatScope.project(id));
        return ResponseEntity.noContent().build();
    }

    // --- the workspace ------------------------------------------------------ //

    @GetMapping("/api/v1/chat")
    public List<ChatMessageResponse> workspaceHistory(
            @RequestParam(required = false) String conversationId) {
        return chat.history(SecurityUtils.currentUserId(), ChatScope.WORKSPACE, conversationId);
    }

    @PostMapping("/api/v1/chat")
    public ChatMessageResponse askWorkspace(@Valid @RequestBody WorkspaceAskRequest req) {
        return chat.askWorkspace(SecurityUtils.currentUserId(), req.question(),
                req.meetingIds(), req.conversationId(), ChatMode.of(req.mode()));
    }

    /**
     * What the composer's mode picker offers.
     *
     * <p>Read from the server rather than written into the client so the two
     * cannot come to describe different behaviour.
     */
    @GetMapping("/api/v1/chat/modes")
    public List<ChatModeResponse> modes() {
        return ChatModeResponse.all();
    }

    @GetMapping("/api/v1/chat/conversations")
    public List<ConversationResponse> workspaceConversations() {
        return chat.listConversations(SecurityUtils.currentUserId(), ChatScope.WORKSPACE);
    }

    @PostMapping("/api/v1/chat/conversations")
    @ResponseStatus(HttpStatus.CREATED)
    public ConversationResponse newWorkspaceConversation() {
        return chat.createConversation(SecurityUtils.currentUserId(), ChatScope.WORKSPACE);
    }

    @DeleteMapping("/api/v1/chat")
    public ResponseEntity<Void> clearWorkspaceHistory() {
        chat.clearScope(SecurityUtils.currentUserId(), ChatScope.WORKSPACE);
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
}
