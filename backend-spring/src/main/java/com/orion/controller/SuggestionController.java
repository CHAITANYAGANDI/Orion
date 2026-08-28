package com.orion.controller;

import com.orion.security.SecurityUtils;
import com.orion.service.MeetingService;
import com.orion.service.WorkspaceSuggestionService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
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
    private final MeetingService meetings;

    public SuggestionController(WorkspaceSuggestionService suggestions, MeetingService meetings) {
        this.suggestions = suggestions;
        this.meetings = meetings;
    }

    /**
     * @param meetingIds what the reader selected through Add context, or absent
     *     for the whole workspace. Chips for a selection have to be about the
     *     selection: leaving workspace-level questions on screen after somebody
     *     picks three meetings is the picker appearing not to have worked.
     */
    @GetMapping("/workspace")
    public Map<String, List<String>> workspace(
            @RequestParam(required = false) List<String> meetingIds) {
        String user = SecurityUtils.currentUserId();
        // Ownership is checked before the ids leave here: they arrive from a
        // client-side picker, and the ai-service would happily read summaries
        // for any id it is handed. Retrieval there is user-filtered so this
        // could not leak a transcript, but it could leak the existence of one.
        if (meetingIds != null && !meetingIds.isEmpty()) {
            meetingIds.forEach(id -> meetings.require(user, id));
            return Map.of("suggestions", suggestions.forSelection(user, meetingIds));
        }
        return Map.of("suggestions", suggestions.forUser(user));
    }
}
