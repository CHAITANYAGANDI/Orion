package com.recallix.export;

import com.recallix.domain.Language;

import java.util.List;

/**
 * A meeting as a document, before anyone has decided what kind of file it is.
 *
 * <p>The reason this exists rather than four renderers each reading the entities
 * directly: the four formats have to agree. A PDF that keeps an empty "Budget"
 * heading and a DOCX that drops it are two different accounts of the same
 * meeting, and the difference would only ever be noticed by whoever is holding
 * both in a meeting room. Assembling the document once and rendering it four
 * ways makes that class of divergence impossible rather than merely unlikely.
 *
 * <p>The blocks are deliberately few and shallow. Every renderer has to handle
 * every one of them, so a block earns its place by being something all four
 * formats can express — a heading, prose, a list, a checklist, a transcript.
 * Anything more expressive would be a thing PDF could do and plain text could
 * only approximate, and the approximation is where the accounts start to differ.
 *
 * @param title    the meeting's own title, as the document's title
 * @param meta     the spec line under it — date, length, tags — joined by the renderer
 * @param notice   a caveat shown above the body, or null; currently only used to
 *                 say that what follows is a translation and what it came from
 * @param language what language the body is written in, which decides the script
 *                 a PDF has to typeset and the direction it runs in; null means
 *                 the meeting's language was never detected, handled as English
 * @param blocks   the body, in reading order
 */
public record ExportDocument(
        String title,
        List<String> meta,
        String notice,
        Language language,
        List<Block> blocks
) {

    /** True when the body runs right to left, so PDF and DOCX can say so. */
    public boolean rightToLeft() {
        return language != null && language.rightToLeft();
    }

    /**
     * One piece of the document.
     *
     * <p>Sealed so that adding a block is a compile error in all four renderers
     * rather than a silently missing section in three of them.
     */
    public sealed interface Block {

        /** A section heading. Level 1 is a section, level 2 an outline group. */
        record Heading(int level, String text) implements Block {
        }

        /** Paragraphs, separated by blank lines within the text. */
        record Prose(String text) implements Block {
        }

        record Bullets(List<String> items) implements Block {
        }

        record Tasks(List<Task> items) implements Block {
        }

        record Transcript(List<Utterance> lines) implements Block {
        }

        /**
         * A remark about the document rather than a part of it — "Not
         * discussed." under a heading the template asked for and the meeting
         * never reached.
         */
        record Aside(String text) implements Block {
        }
    }

    /**
     * An action item as it appears in a file.
     *
     * <p>{@code detail} is the owner, deadline and priority already joined,
     * because how they read as one line is a decision about the document, not
     * about the format: four renderers making it separately is four chances to
     * make it differently.
     */
    public record Task(boolean done, String title, String detail) {
    }

    public record Utterance(String timecode, String speaker, String text) {

        /**
         * The line above the words: "[00:12] Speaker 1", or whichever half of
         * that survived the export options, or nothing at all.
         *
         * <p>Here rather than in each renderer because all four had the same
         * "[time] speaker" concatenation hard-coded, and making timestamps and
         * names optional would otherwise have meant writing the same three-way
         * conditional four times and keeping them in step.
         */
        public String label() {
            boolean hasTime = timecode != null && !timecode.isBlank();
            boolean hasSpeaker = speaker != null && !speaker.isBlank();
            if (hasTime && hasSpeaker) {
                return "[" + timecode + "] " + speaker;
            }
            if (hasTime) {
                return "[" + timecode + "]";
            }
            return hasSpeaker ? speaker : "";
        }
    }
}
