package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.dto.TranslateResponse;
import com.recallix.entity.MeetingSummary;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Arrays;
import java.util.List;

/** Translates a meeting's summary into another language via the ai-service. */
@Service
public class TranslationService {

    private final MeetingRepository meetings;
    private final MeetingSummaryRepository summaries;
    private final AiClient ai;

    public TranslationService(MeetingRepository meetings,
                              MeetingSummaryRepository summaries,
                              AiClient ai) {
        this.meetings = meetings;
        this.summaries = summaries;
        this.ai = ai;
    }

    @Transactional(readOnly = true)
    public TranslateResponse translateSummary(String userId, String meetingId, String targetLanguage) {
        meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));
        MeetingSummary summary = summaries.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                .orElseThrow(() -> ApiException.notFound("Summary not ready"));

        String shortT = translate(summary.getShortSummary(), targetLanguage);
        String detailedT = translate(summary.getDetailedSummary(), targetLanguage);

        List<String> keyPoints = summary.getKeyPoints();
        List<String> keyPointsT = List.of();
        if (keyPoints != null && !keyPoints.isEmpty()) {
            String joined = translate(String.join("\n", keyPoints), targetLanguage);
            keyPointsT = Arrays.stream(joined.split("\n"))
                    .map(String::trim).filter(s -> !s.isEmpty()).toList();
        }

        return new TranslateResponse(targetLanguage, shortT, detailedT, keyPointsT);
    }

    private String translate(String text, String targetLanguage) {
        if (text == null || text.isBlank()) {
            return "";
        }
        return ai.translate(text, targetLanguage);
    }
}
