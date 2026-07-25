package com.recallix.controller;

import com.recallix.dto.SemanticSearchHit;
import com.recallix.dto.SemanticSearchRequest;
import com.recallix.security.SecurityUtils;
import com.recallix.service.SemanticSearchService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Semantic search over transcripts. Complements the keyword/status filtering on
 * {@code GET /api/v1/meetings}: this finds meetings by what was <em>said</em>,
 * not by what the meeting was titled.
 */
@RestController
@RequestMapping("/api/v1/search")
public class SearchController {

    private final SemanticSearchService search;

    public SearchController(SemanticSearchService search) {
        this.search = search;
    }

    @PostMapping("/semantic")
    public List<SemanticSearchHit> semantic(@Valid @RequestBody SemanticSearchRequest req) {
        return search.search(SecurityUtils.currentUserId(), req.query(), req.limit());
    }
}
