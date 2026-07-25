package com.recallix.service;

import com.recallix.dto.SemanticSearchHit;
import com.recallix.entity.Meeting;
import com.recallix.repository.MeetingRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Meaning-based search across a user's transcripts.
 *
 * <p>Retrieval happens in the ai-service (pgvector, filtered by user_id); this
 * service enriches the hits with live meeting metadata so the UI can render
 * status badges and dates without a second call. Meetings that have since been
 * deleted are dropped rather than returned as dangling results.
 */
@Service
public class SemanticSearchService {

    private final AiClient ai;
    private final MeetingRepository meetings;

    public SemanticSearchService(AiClient ai, MeetingRepository meetings) {
        this.ai = ai;
        this.meetings = meetings;
    }

    @Transactional(readOnly = true)
    public List<SemanticSearchHit> search(String userId, String query, Integer limit) {
        List<AiClient.SearchHit> hits = ai.semanticSearch(userId, query, limit);
        if (hits.isEmpty()) {
            return List.of();
        }

        List<String> ids = hits.stream().map(AiClient.SearchHit::meetingId).toList();
        Map<String, Meeting> byId = meetings.findAllById(ids).stream()
                .filter(m -> userId.equals(m.getUserId()))
                .collect(Collectors.toMap(Meeting::getId, Function.identity()));

        return hits.stream()
                .filter(h -> byId.containsKey(h.meetingId()))
                .map(h -> {
                    Meeting m = byId.get(h.meetingId());
                    return new SemanticSearchHit(
                            m.getId(),
                            m.getTitle(),
                            m.getStatus() == null ? null : m.getStatus().name(),
                            m.getCreatedAt(),
                            h.chunkIndex(),
                            h.snippet(),
                            h.start(),
                            h.end(),
                            h.score());
                })
                .toList();
    }
}
