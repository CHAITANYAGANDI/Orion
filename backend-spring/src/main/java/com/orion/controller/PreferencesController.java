package com.orion.controller;

import com.orion.dto.PreferencesResponse;
import com.orion.dto.PreferencesUpdateRequest;
import com.orion.security.SecurityUtils;
import com.orion.service.UserService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Server-side settings. Everything here is scoped to the caller. */
@RestController
@RequestMapping("/api/v1/preferences")
public class PreferencesController {

    private final UserService users;

    public PreferencesController(UserService users) {
        this.users = users;
    }

    @GetMapping
    public PreferencesResponse get() {
        return PreferencesResponse.from(users.require(SecurityUtils.currentUserId()));
    }

    @PatchMapping
    public PreferencesResponse update(@Valid @RequestBody PreferencesUpdateRequest req) {
        return PreferencesResponse.from(users.updatePreferences(
                SecurityUtils.currentUserId(),
                new UserService.PreferencesPatch(
                        req.displayName(), req.department(), req.jobRole(),
                        req.pronouns(), req.email(), req.avatarUrl(), req.defaultLanguage(),
                        req.chatHistoryDays(), req.chatReadsEverything(),
                        req.mutedNotifications())));
    }
}
