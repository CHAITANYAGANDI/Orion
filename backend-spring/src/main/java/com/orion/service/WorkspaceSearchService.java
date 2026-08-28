package com.orion.service;

import com.orion.common.SearchTerms;
import com.orion.dto.SearchFacets;
import com.orion.dto.SearchQuery;
import com.orion.dto.SearchResponse;
import com.orion.dto.SearchResponse.MeetingHit;
import com.orion.dto.SearchResponse.SearchGroup;
import com.orion.entity.Meeting;
import com.orion.repository.MeetingRepository;
import com.orion.repository.SearchRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * One search, answered across the whole workspace.
 *
 * <p><b>Why one endpoint and not five.</b> The page shows five counts at once.
 * Five requests would render them at five different moments — the meeting count
 * arriving before the transcript count, both re-arriving on the next keystroke —
 * and each would carry the same filters, so a filter change would be five
 * chances to get out of step. One request means the numbers on screen always
 * describe the same query.
 *
 * <p><b>What an empty search returns.</b> Recent meetings, and nothing else. The
 * alternative is either an empty page, which wastes the most-visited screen in
 * the app, or every decision and every commitment in the archive, which is a
 * scan of everything to show a list nobody asked for. A filter counts as a
 * search, though: "last week, Priya spoke" is a question even with no words in
 * the box, and is answered in full.
 */
@Service
public class WorkspaceSearchService {

    private final SearchRepository search;
    private final MeetingRepository meetings;

    public WorkspaceSearchService(SearchRepository search, MeetingRepository meetings) {
        this.search = search;
        this.meetings = meetings;
    }

    @Transactional(readOnly = true)
    public SearchResponse search(String userId, SearchQuery q) {
        String tsq = SearchTerms.toTsQuery(q.text());
        String like = SearchTerms.toLike(q.text());
        boolean browsing = q.isEmpty();

        SearchGroup<MeetingHit> meetingHits = q.wants("meetings")
                ? enrich(search.meetings(userId, q, tsq, like))
                : SearchGroup.empty();

        return new SearchResponse(
                q.text(),
                meetingHits,
                q.wants("people") && !browsing
                        ? search.people(userId, q, like)
                        : SearchGroup.empty(),
                q.wants("decisions") && !browsing
                        ? search.insights(userId, q, like, "DECISION")
                        : SearchGroup.empty(),
                q.wants("risks") && !browsing
                        ? search.insights(userId, q, like, "RISK")
                        : SearchGroup.empty(),
                q.wants("commitments") && !browsing
                        ? search.commitments(userId, q, like)
                        : SearchGroup.empty(),
                // No usable term means no full-text query to run: `to_tsquery`
                // has nothing to parse, and every utterance would be a "match".
                q.wants("mentions") && !tsq.isEmpty()
                        ? search.mentions(userId, q, tsq)
                        : SearchGroup.empty());
    }

    @Transactional(readOnly = true)
    public SearchFacets facets(String userId) {
        return search.facets(userId);
    }

    /**
     * Attaches live meeting metadata to the ids the match query returned.
     *
     * <p>Same shape as {@code SemanticSearchService}, and for the same reason:
     * the search decides <em>which</em> meetings, the entity decides what they
     * currently look like, and a row whose meeting has been deleted in between
     * is dropped rather than rendered as a link to nothing.
     */
    private SearchGroup<MeetingHit> enrich(SearchGroup<SearchRepository.MeetingMatch> matches) {
        if (matches.hits().isEmpty()) {
            return SearchGroup.empty();
        }
        List<String> ids = matches.hits().stream().map(SearchRepository.MeetingMatch::id).toList();
        Map<String, Meeting> byId = meetings.findAllById(ids).stream()
                .collect(Collectors.toMap(Meeting::getId, Function.identity()));

        List<MeetingHit> hits = new ArrayList<>(ids.size());
        for (SearchRepository.MeetingMatch match : matches.hits()) {
            Meeting m = byId.get(match.id());
            if (m == null) {
                continue;
            }
            hits.add(new MeetingHit(
                    m.getId(),
                    m.getTitle(),
                    m.getStatus() == null ? null : m.getStatus().name(),
                    m.getCreatedAt(),
                    m.getDurationSeconds(),
                    List.copyOf(m.getTags()),
                    m.getSummaryTemplate(),
                    match.mentions(),
                    match.titleMatch()));
        }
        return new SearchGroup<>(matches.total(), hits);
    }
}
