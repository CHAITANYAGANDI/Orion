package com.orion.export;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Naming a file somebody is about to find in their downloads folder.
 *
 * <p>Two problems, both of which show up the first time a meeting is not called
 * "Sprint planning".
 *
 * <p><strong>The name has to survive a filesystem.</strong> A title can contain
 * a slash, a colon or a quote, and Windows will refuse the file rather than
 * clean it up, so the stem is built from letters and digits and nothing else.
 * Letters, not ASCII letters: a meeting called 四半期レビュー should download as
 * itself, not as {@code meeting.pdf}.
 *
 * <p><strong>The header has to survive HTTP.</strong> {@code Content-Disposition}
 * is a Latin-1 header, so a Unicode name goes in {@code filename*} per RFC 5987
 * and a stripped-down one in plain {@code filename} for anything that does not
 * read the starred form. Sending only the starred form loses the name on older
 * clients; sending only the plain one loses every non-Latin title.
 */
public final class Downloads {

    private static final int MAX_STEM = 60;

    private Downloads() {
    }

    /**
     * A filesystem-safe stem from a meeting title, in whatever script it is in.
     */
    public static String slug(String title) {
        if (title == null) {
            return "meeting";
        }
        StringBuilder out = new StringBuilder();
        boolean pendingDash = false;
        for (int i = 0; i < title.length(); i++) {
            char c = title.charAt(i);
            if (!Character.isLetterOrDigit(c)) {
                pendingDash = true;
                continue;
            }
            boolean dash = pendingDash && out.length() > 0;
            if (out.length() + (dash ? 2 : 1) > MAX_STEM) {
                break;
            }
            if (dash) {
                out.append('-');
            }
            pendingDash = false;
            out.append(Character.toLowerCase(c));
        }
        return out.isEmpty() ? "meeting" : out.toString();
    }

    /**
     * The {@code Content-Disposition} value for a download, in both spellings.
     */
    public static String attachment(String filename) {
        String ascii = filename.replaceAll("[^\\x20-\\x7E]", "").replace("\"", "");
        if (ascii.isBlank() || ascii.startsWith(".")) {
            // Nothing Latin survived — a wholly Japanese or Arabic title. The
            // plain form is only a fallback, so an honest generic beats a
            // string of hyphens.
            ascii = "meeting" + extension(filename);
        }
        return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + rfc5987(filename);
    }

    private static String extension(String filename) {
        int dot = filename.lastIndexOf('.');
        return dot < 0 ? "" : filename.substring(dot).toLowerCase(Locale.ROOT);
    }

    /**
     * Percent-encoding as RFC 5987 wants it, which is not what
     * {@code URLEncoder} produces: space is {@code %20} rather than {@code +},
     * and the few characters it leaves alone are ones a header can carry.
     */
    private static String rfc5987(String value) {
        try {
            return URLEncoder.encode(value, StandardCharsets.UTF_8.name())
                    .replace("+", "%20")
                    .replace("*", "%2A")
                    .replace("%7E", "~");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException("UTF-8 is always supported", e);
        }
    }
}
