package com.recallix.dto;

/**
 * What deleting an exchange actually removed.
 *
 * <p>This exists because a 204 was not enough information. Deleting the last
 * exchange in a thread also deletes the thread, and a client holding that
 * conversation id in state had no way to learn it had gone — so its next read
 * asked for a conversation that no longer existed, got a 404, and the chat
 * appeared to empty itself and then refuse every subsequent action.
 *
 * <p>{@code conversationDeleted} is the flag that lets the caller drop the id
 * and fall back to "whatever I was last saying here".
 */
public record ExchangeDeleteResponse(
        /** 2 for a question and its answer, 1 for a turn with no partner. */
        int deletedMessages,
        boolean conversationDeleted
) {
}
