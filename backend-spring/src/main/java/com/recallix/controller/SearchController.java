package com.recallix.controller;

import com.recallix.dto.SearchFacets;
import com.recallix.dto.SearchQuery;
import com.recallix.dto.SearchResponse;
import com.recallix.dto.SemanticSearchHit;
import com.recallix.dto.SemanticSearchRequest;
import com.recallix.security.SecurityUtils;
import com.recallix.service.SemanticSearchService;
import com.recallix.service.WorkspaceSearchService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Search, in two forms that answer different questions.
 *
 * <p>{@code GET /search} is the workspace search: exact terms, across meetings,
 * people, decisions, commitments and utterances at once, narrowed by filters.
 * {@code POST /search/semantic} finds passages by meaning, for when the wording
 * is not known.
 *
 * <p><b>Why the first is a GET and the second a POST.</b> Not consistency for
 * its own sake — the workspace search is idempotent, cacheable, and worth having
 * in the URL, because "everything Priya said about pricing last quarter" is a
 * view someone will want to bookmark or send to themselves. Semantic search
 * embeds its query, which costs a model call per request; putting it behind a
 * POST keeps it out of the browser's automatic re-requests.
 */
@RestController
@RequestMapping("/api/v1/search")
public class SearchController {

    private final SemanticSearchService semantic;
    private final WorkspaceSearchService workspace;

    public SearchController(SemanticSearchService semantic, WorkspaceSearchService workspace) {
        this.semantic = semantic;
        this.workspace = workspace;
    }

    /**
     * @param groups which result groups to answer, comma-separated. Absent means
     *               all of them — the overview. Naming one is how "see all 27
     *               transcript mentions" asks for a deeper page of that group
     *               alone, instead of re-running four queries it will not show.
     */
    @GetMapping
    public SearchResponse search(
            @RequestParam(name = "q", defaultValue = "") String q,
            @RequestParam(name = "groups", defaultValue = "") String groups,
            @RequestParam(defaultValue = "5") int limit,
            @RequestParam(defaultValue = "0") int offset,
            @RequestParam(defaultValue = "") String from,
            @RequestParam(defaultValue = "") String to,
            @RequestParam(defaultValue = "") String status,
            @RequestParam(defaultValue = "") String type,
            @RequestParam(defaultValue = "") String tag,
            @RequestParam(defaultValue = "") String project,
            @RequestParam(defaultValue = "") String speaker,
            @RequestParam(defaultValue = "") String owner,
            @RequestParam(defaultValue = "false") boolean withDecisions) {

        return workspace.search(SecurityUtils.currentUserId(), new SearchQuery(
                q, parseGroups(groups), limit, offset,
                from, to, status, type, tag, project, speaker, owner, withDecisions));
    }

    /** The values each filter can take in this workspace — see {@link SearchFacets}. */
    @GetMapping("/facets")
    public SearchFacets facets() {
        return workspace.facets(SecurityUtils.currentUserId());
    }

    @PostMapping("/semantic")
    public List<SemanticSearchHit> semantic(@Valid @RequestBody SemanticSearchRequest req) {
        return semantic.search(SecurityUtils.currentUserId(), req.query(), req.limit());
    }

    /**
     * Unknown group names are dropped rather than rejected.
     *
     * <p>A client asking for a group this version does not have should get the
     * ones it does, not a 400 for the whole search; and dropping them cannot
     * widen the query, since an empty set falls back to every group the server
     * already knows.
     */
    private static Set<String> parseGroups(String csv) {
        if (csv == null || csv.isBlank()) {
            return SearchQuery.ALL_GROUPS;
        }
        return Arrays.stream(csv.split(","))
                .map(String::trim)
                .filter(SearchQuery.ALL_GROUPS::contains)
                .collect(Collectors.toUnmodifiableSet());
    }
}
