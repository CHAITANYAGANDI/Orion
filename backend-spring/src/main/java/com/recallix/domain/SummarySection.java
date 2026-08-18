package com.recallix.domain;

import java.util.List;

/**
 * One section of a summary, as written by the template that produced it.
 *
 * <p>Lives in {@code domain} rather than {@code dto} because it is both
 * persisted (as JSONB on {@code meeting_summaries.sections_json}) and returned
 * over the API unchanged — the stored shape and the wire shape are the same
 * thing, and giving them two classes would only invite them to drift.
 *
 * <p>Only the field matching {@code kind} carries content: {@code prose} uses
 * {@code text}, {@code bullets} uses {@code bullets}, {@code outline} uses
 * {@code groups}. The backend never inspects which — it stores what the
 * ai-service wrote and hands it to the client, so a new section kind needs no
 * change here.
 *
 * <p>A section with no content is normal and is kept, not dropped: "Budget was
 * not discussed" is a finding, and silently omitting the heading would leave
 * the reader unable to tell an empty section from one the template never asked
 * for.
 */
public record SummarySection(
        String key,
        String title,
        String kind,
        String text,
        List<String> bullets,
        List<OutlineGroup> groups
) {
    public List<String> bulletsOrEmpty() {
        return bullets == null ? List.of() : bullets;
    }

    public List<OutlineGroup> groupsOrEmpty() {
        return groups == null ? List.of() : groups;
    }

    /**
     * A heading with its bullets — the repeating unit of an {@code outline}.
     *
     * <p>{@code startSeconds} is where the topic begins in the recording, so a
     * reader can click the heading and hear it. Nullable, and often null: the
     * ai-service establishes it by finding the line the model says opened the
     * topic in the transcript, and a heading whose line cannot be found gets
     * nothing rather than a guess. Summaries written before this existed have
     * it null throughout, which is the same case and needs no special handling
     * — including in the JSON already stored, where an absent field decodes to
     * null without a migration.
     */
    public record OutlineGroup(String heading, List<String> bullets, Double startSeconds) {
        public List<String> bulletsOrEmpty() {
            return bullets == null ? List.of() : bullets;
        }
    }
}
