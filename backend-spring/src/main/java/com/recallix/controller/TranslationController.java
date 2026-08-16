package com.recallix.controller;

import com.recallix.domain.Language;
import com.recallix.dto.LanguageResponse;
import com.recallix.dto.TranslateRequest;
import com.recallix.dto.TranslationResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.TranslationService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
public class TranslationController {

    private final TranslationService translations;

    public TranslationController(TranslationService translations) {
        this.translations = translations;
    }

    /**
     * The languages Recallix works in.
     *
     * <p>Unauthenticated data — it is a property of the product, not of the
     * caller — but served from here so the browser's picker and the validation
     * that rejects a bad target are reading the same list. See
     * {@link Language} for why input audio and translation targets currently
     * share it.
     */
    @GetMapping("/api/v1/languages")
    public List<LanguageResponse> languages() {
        return Language.all().stream().map(LanguageResponse::from).toList();
    }

    /** Which languages this meeting already exists in. */
    @GetMapping("/api/v1/meetings/{id}/translations")
    public List<TranslationResponse.Available> available(@PathVariable String id) {
        return translations.available(SecurityUtils.currentUserId(), id);
    }

    /**
     * Translate the meeting, or refresh a translation it has outgrown.
     *
     * <p>Returns what is stored without spending a model call when the work has
     * already been done — so this is safe to call on every language switch, and
     * the client does not have to keep track of what exists.
     */
    @PostMapping("/api/v1/meetings/{id}/translations")
    public TranslationResponse translate(@PathVariable String id,
                                         @Valid @RequestBody TranslateRequest req) {
        return translations.translate(SecurityUtils.currentUserId(), id,
                req.targetLanguage(), req.includeTranscript());
    }

    @GetMapping("/api/v1/meetings/{id}/translations/{language}")
    public TranslationResponse get(@PathVariable String id, @PathVariable String language) {
        return translations.get(SecurityUtils.currentUserId(), id, language);
    }

    @DeleteMapping("/api/v1/meetings/{id}/translations/{language}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable String id, @PathVariable String language) {
        translations.delete(SecurityUtils.currentUserId(), id, language);
    }
}
