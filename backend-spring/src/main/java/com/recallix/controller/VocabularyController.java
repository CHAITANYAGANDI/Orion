package com.recallix.controller;

import com.recallix.dto.VocabularyTermRequest;
import com.recallix.dto.VocabularyTermResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.VocabularyService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Custom transcription vocabulary.
 *
 * <p>Terms take effect on the next meeting processed — they are sent with the
 * transcription job, so an existing transcript has to be reprocessed to benefit
 * from a term added after it ran.
 */
@RestController
@RequestMapping("/api/v1/vocabulary")
public class VocabularyController {

    private final VocabularyService vocabulary;

    public VocabularyController(VocabularyService vocabulary) {
        this.vocabulary = vocabulary;
    }

    @GetMapping
    public List<VocabularyTermResponse> list() {
        return vocabulary.list(SecurityUtils.currentUserId());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public VocabularyTermResponse create(@Valid @RequestBody VocabularyTermRequest req) {
        return vocabulary.create(SecurityUtils.currentUserId(), req);
    }

    @PutMapping("/{id}")
    public VocabularyTermResponse update(@PathVariable String id,
                                         @Valid @RequestBody VocabularyTermRequest req) {
        return vocabulary.update(SecurityUtils.currentUserId(), id, req);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        vocabulary.delete(SecurityUtils.currentUserId(), id);
        return ResponseEntity.noContent().build();
    }
}
