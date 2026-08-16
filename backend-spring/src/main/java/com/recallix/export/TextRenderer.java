package com.recallix.export;

import com.recallix.domain.ExportFormat;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Plain text — the format that outlives the others.
 *
 * <p>Two decisions worth writing down.
 *
 * <p><strong>Headings are underlined, not shouted.</strong> Upper-casing a
 * heading is a locale-dependent transformation of somebody's words — Turkish
 * disagrees with English about the letter i, and in Japanese or Arabic it does
 * nothing at all — so the structure is carried by a rule of dashes under the
 * text instead, which reads the same in every script.
 *
 * <p><strong>Lines are wrapped.</strong> Notepad does not soft-wrap by default
 * and a transcript is thousands of characters per paragraph, so an unwrapped
 * file is one enormously long line per utterance. The wrap measures display
 * width rather than {@code String.length}, because a Japanese character takes
 * two columns and a 78-character line of it overruns a terminal by 78.
 */
@Component
public class TextRenderer implements DocumentRenderer {

    /** Columns. Wide enough not to look cramped, narrow enough for a terminal. */
    private static final int WIDTH = 78;

    @Override
    public ExportFormat format() {
        return ExportFormat.TXT;
    }

    @Override
    public byte[] render(ExportDocument doc) {
        List<String> out = new ArrayList<>();

        out.add(doc.title());
        out.add(rule('=', doc.title()));
        if (!doc.meta().isEmpty()) {
            out.addAll(wrap(String.join(" · ", doc.meta()), 0));
        }
        if (doc.notice() != null) {
            out.add("");
            out.addAll(wrap(doc.notice(), 0));
        }

        for (ExportDocument.Block block : doc.blocks()) {
            out.add("");
            switch (block) {
                case ExportDocument.Block.Heading h -> {
                    out.add(h.text());
                    if (h.level() == 1) {
                        out.add(rule('-', h.text()));
                    }
                }
                case ExportDocument.Block.Prose p -> {
                    for (String paragraph : p.text().split("\n")) {
                        if (paragraph.isBlank()) {
                            out.add("");
                        } else {
                            out.addAll(wrap(paragraph, 0));
                        }
                    }
                }
                case ExportDocument.Block.Aside a -> out.addAll(wrap(a.text(), 0));
                case ExportDocument.Block.Bullets b -> {
                    for (String item : b.items()) {
                        out.addAll(hanging("  - ", item, 4));
                    }
                }
                case ExportDocument.Block.Tasks t -> {
                    for (ExportDocument.Task task : t.items()) {
                        // ASCII rather than the ballot-box characters: this is
                        // the format chosen for surviving everything, and U+2610
                        // is missing from more fonts than people expect.
                        out.addAll(hanging(task.done() ? "  [x] " : "  [ ] ", task.title(), 6));
                        if (!task.detail().isBlank()) {
                            out.addAll(wrap(task.detail(), 6));
                        }
                    }
                }
                case ExportDocument.Block.Transcript t -> {
                    for (ExportDocument.Utterance line : t.lines()) {
                        // Speaker and time on their own line so the words below
                        // wrap against a straight left margin.
                        out.add("[" + line.timecode() + "] " + line.speaker());
                        out.addAll(wrap(line.text(), 4));
                        out.add("");
                    }
                }
            }
        }

        out.add("");
        out.add("--");
        out.add("Exported from Recallix AI");
        out.add("");
        return String.join("\n", out).getBytes(StandardCharsets.UTF_8);
    }

    /* ------------------------------- layout ------------------------------- */

    private static String rule(char c, String over) {
        return String.valueOf(c).repeat(Math.max(3, Math.min(width(over), WIDTH)));
    }

    /** A first line with its own prefix, and continuations indented under it. */
    private static List<String> hanging(String prefix, String text, int indent) {
        List<String> wrapped = wrap(text, indent);
        if (wrapped.isEmpty()) {
            return List.of(prefix.stripTrailing());
        }
        List<String> out = new ArrayList<>(wrapped);
        out.set(0, prefix + wrapped.get(0).stripLeading());
        return out;
    }

    /**
     * Break {@code text} to fit, indenting every line.
     *
     * <p>Words are kept whole where they fit. A "word" longer than the line —
     * a URL, or a whole sentence of Japanese, which has no spaces to break on —
     * is broken at the margin, which is the right answer for both: a URL that
     * overruns is unreadable either way, and Chinese and Japanese are legitimately
     * broken between any two characters.
     */
    private static List<String> wrap(String text, int indent) {
        String pad = " ".repeat(indent);
        int room = Math.max(20, WIDTH - indent);
        List<String> lines = new ArrayList<>();
        StringBuilder line = new StringBuilder();
        int used = 0;

        for (String word : text.strip().split("\\s+")) {
            if (word.isEmpty()) {
                continue;
            }
            int w = width(word);
            if (used > 0 && used + 1 + w > room) {
                lines.add(pad + line);
                line.setLength(0);
                used = 0;
            }
            if (w > room) {
                // Too long to fit on any line: fill whole lines to the margin and
                // leave the remainder as the current line, so what follows can
                // still join it.
                for (int i = 0; i < word.length(); ) {
                    int take = 0;
                    int taken = 0;
                    while (i + take < word.length() && taken + charWidth(word.charAt(i + take)) <= room) {
                        taken += charWidth(word.charAt(i + take));
                        take++;
                    }
                    take = Math.max(take, 1);
                    if (i + take < word.length()) {
                        lines.add(pad + word.substring(i, i + take));
                    } else {
                        line.append(word, i, word.length());
                        used = taken;
                    }
                    i += take;
                }
                continue;
            }
            if (used > 0) {
                line.append(' ');
                used++;
            }
            line.append(word);
            used += w;
        }
        if (used > 0) {
            lines.add(pad + line);
        }
        return lines;
    }

    private static int width(String s) {
        int w = 0;
        for (int i = 0; i < s.length(); i++) {
            w += charWidth(s.charAt(i));
        }
        return w;
    }

    /** Two columns for the ranges a monospaced terminal draws double-wide. */
    private static int charWidth(char c) {
        return (c >= 0x1100 && c <= 0x115F)          // Hangul jamo
                || (c >= 0x2E80 && c <= 0xA4CF)      // CJK radicals through Yi
                || (c >= 0xAC00 && c <= 0xD7A3)      // Hangul syllables
                || (c >= 0xF900 && c <= 0xFAFF)      // CJK compatibility
                || (c >= 0xFF00 && c <= 0xFF60)      // full-width forms
                ? 2 : 1;
    }
}
