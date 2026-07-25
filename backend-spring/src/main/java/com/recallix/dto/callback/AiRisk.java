package com.recallix.dto.callback;

public record AiRisk(
        String risk,
        String severity,
        String sourceSentence
) {
}
