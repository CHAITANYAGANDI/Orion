package com.recallix.dto.callback;

public record AiDecision(
        String decision,
        String confidence,
        String sourceSentence
) {
}
