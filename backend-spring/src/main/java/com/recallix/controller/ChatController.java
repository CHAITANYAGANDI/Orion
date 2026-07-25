package com.recallix.controller;

import com.recallix.dto.ChatAskRequest;
import com.recallix.dto.ChatMessageResponse;
import com.recallix.dto.TranslateRequest;
import com.recallix.dto.TranslateResponse;
import com.recallix.dto.WorkspaceAskRequest;
import com.recallix.security.SecurityUtils;
import com.recallix.service.ChatService;
import com.recallix.service.TranslationService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * RAG chat at two scopes — one meeting, or the whole workspace — plus summary
 * translation.
 */
@RestController
public class ChatController {

    private final ChatService chat;
    private final TranslationService translation;

    public ChatController(ChatService chat, TranslationService translation) {
        this.chat = chat;
        this.translation = translation;
    }

    @GetMapping("/api/v1/meetings/{id}/chat")
    public List<ChatMessageResponse> history(@PathVariable String id) {
        return chat.history(SecurityUtils.currentUserId(), id);
    }

    @PostMapping("/api/v1/meetings/{id}/chat")
    public ChatMessageResponse ask(@PathVariable String id, @Valid @RequestBody ChatAskRequest req) {
        return chat.ask(SecurityUtils.currentUserId(), id, req.question());
    }

    @PostMapping("/api/v1/meetings/{id}/translate")
    public TranslateResponse translate(@PathVariable String id, @Valid @RequestBody TranslateRequest req) {
        return translation.translateSummary(SecurityUtils.currentUserId(), id, req.targetLanguage());
    }

    // --- workspace-wide chat: grounded across every meeting the user owns --- //

    @GetMapping("/api/v1/chat")
    public List<ChatMessageResponse> workspaceHistory() {
        return chat.workspaceHistory(SecurityUtils.currentUserId());
    }

    @PostMapping("/api/v1/chat")
    public ChatMessageResponse askWorkspace(@Valid @RequestBody WorkspaceAskRequest req) {
        return chat.askWorkspace(SecurityUtils.currentUserId(), req.question(), req.meetingIds());
    }

    @DeleteMapping("/api/v1/chat")
    public ResponseEntity<Void> clearWorkspaceHistory() {
        chat.clearWorkspaceHistory(SecurityUtils.currentUserId());
        return ResponseEntity.noContent().build();
    }
}
