package com.orion.dto.callback;

/** AI-side action item (note: `taskTitle`, per api-contracts §5). */
public record AiActionItem(
        String taskTitle,
        String ownerName,
        String dueDate,
        String sourceSentence
) {
}
