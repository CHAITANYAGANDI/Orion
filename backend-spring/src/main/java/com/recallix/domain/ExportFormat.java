package com.recallix.domain;

import java.util.Locale;
import java.util.Optional;

/**
 * The file formats a meeting can be downloaded as.
 *
 * <p>Four, and the split between them is about what the file is for rather than
 * about taste. <strong>PDF</strong> is the one you attach to an email and nobody
 * can edit. <strong>DOCX</strong> is the one somebody rewrites into their own
 * minutes. <strong>Markdown</strong> is the one that pastes into Notion, Linear
 * or a commit message without reformatting. <strong>TXT</strong> is the one that
 * survives everything — grep, an old ticketing system, a diff.
 *
 * <p>The extension is also the query parameter, so a URL is readable:
 * {@code ?format=docx} says what will arrive. {@link #find} additionally
 * accepts the words people reach for — "word", "markdown", "text" — because the
 * button in the UI says "Word (.docx)" and an API that only accepts the
 * extension makes a liar of it.
 */
public enum ExportFormat {

    PDF("pdf", "application/pdf"),
    DOCX("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    MARKDOWN("md", "text/markdown;charset=UTF-8"),
    TXT("txt", "text/plain;charset=UTF-8");

    private final String extension;
    private final String mediaType;

    ExportFormat(String extension, String mediaType) {
        this.extension = extension;
        this.mediaType = mediaType;
    }

    public String extension() {
        return extension;
    }

    public String mediaType() {
        return mediaType;
    }

    public static Optional<ExportFormat> find(String raw) {
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        return switch (raw.trim().toLowerCase(Locale.ROOT)) {
            case "pdf" -> Optional.of(PDF);
            case "docx", "word", "doc" -> Optional.of(DOCX);
            case "md", "markdown" -> Optional.of(MARKDOWN);
            case "txt", "text", "plain" -> Optional.of(TXT);
            default -> Optional.empty();
        };
    }
}
