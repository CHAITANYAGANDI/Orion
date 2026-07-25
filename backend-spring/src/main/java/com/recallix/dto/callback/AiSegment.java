package com.recallix.dto.callback;

public record AiSegment(
        Double start,
        Double end,
        String speaker,
        String text
) {
}
