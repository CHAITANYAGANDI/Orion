package com.recallix.controller;

import com.recallix.security.SecurityUtils;
import com.recallix.service.WorkspaceSuggestionService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * Starter questions for the workspace chat.
 *
 * <p>A meeting's questions ride on its summary, which the meeting page already
 * loads — a second request would make the chips appear after the chat they sit
 * above. The workspace has no such carrier, so it gets an endpoint.
 *
 * <p>Always 200, including for a user with nothing to suggest about. The chips
 * are a convenience and the page works without them; an error here would make
 * the chat look broken because a nicety was unavailable.
 */
@RestController
@RequestMapping("/api/v1/suggestions")
public class SuggestionController {

    private final WorkspaceSuggestionService suggestions;

    public SuggestionController(WorkspaceSuggestionService suggestions) {
        this.suggestions = suggestions;
    }

    @GetMapping("/workspace")
    public Map<String, List<String>> workspace() {
        return Map.of("suggestions", suggestions.forUser(SecurityUtils.currentUserId()));
    }
}
