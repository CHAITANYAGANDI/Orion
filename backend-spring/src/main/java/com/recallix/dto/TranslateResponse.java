package com.recallix.dto;

import java.util.List;

public record TranslateResponse(
        String targetLanguage,
        String shortSummary,
        String detailedSummary,
        List<String> keyPoints
) {
}
