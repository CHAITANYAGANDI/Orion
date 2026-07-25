package com.recallix.dto;

public record CitationDto(
        int chunkIndex,
        Double start,
        Double end,
        String text
) {
}
