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

    /** A heading with its bullets — the repeating unit of an {@code outline}. */
    public record OutlineGroup(String heading, List<String> bullets) {
        public List<String> bulletsOrEmpty() {
            return bullets == null ? List.of() : bullets;
        }
    }
}
