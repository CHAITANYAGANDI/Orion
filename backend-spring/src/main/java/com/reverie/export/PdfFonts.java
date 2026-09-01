package com.reverie.export;

import com.reverie.domain.Language;
import org.openpdf.text.DocumentException;
import org.openpdf.text.Font;
import org.openpdf.text.pdf.BaseFont;
import org.openpdf.text.pdf.FontSelector;
import org.springframework.stereotype.Component;

import java.awt.Color;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Fonts for the PDF, chosen by the script the meeting is written in.
 *
 * <p>This class exists because of the one thing a PDF does that no other export
 * format does: it carries its own typesetting. A DOCX names a font and Word
 * finds one; a PDF that names a font the reader does not have draws empty boxes.
 * Reverie works in eighteen languages across five scripts, so "just use
 * Helvetica" produces a Japanese meeting rendered as several thousand rectangles.
 *
 * <p><strong>Latin, Greek, Cyrillic</strong> — Noto Sans, embedded and subset,
 * which covers every one of the thirteen Latin-script languages including
 * Vietnamese and Turkish.
 *
 * <p><strong>Arabic, Hebrew, Devanagari</strong> — the matching Noto script
 * font, embedded. Arabic and Hebrew additionally need the text laid out right to
 * left and Arabic needs its letters joined; both are done by the renderer
 * setting a run direction, which is the part OpenPDF is unusually good at.
 *
 * <p><strong>Japanese and Chinese</strong> — the Adobe character collections
 * that ship with OpenPDF, not embedded. This is the standard arrangement for
 * CJK and the reason this repository does not carry a sixteen-megabyte font: the
 * PDF references Adobe-Japan1 or Adobe-GB1 and the reader supplies the glyphs,
 * which every mainstream reader does.
 *
 * <p><strong>A known limit.</strong> Devanagari needs conjunct formation and
 * vowel-sign reordering, which is shaping that OpenPDF does not do — a Hindi
 * export is legible but not correctly typeset. Fixing it properly means a
 * shaping engine (HarfBuzz, or a browser), which is a much larger change than
 * this one; the alternative today would be refusing to export Hindi at all, and
 * a readable file beats no file.
 *
 * <p>Every text run goes through a {@link FontSelector} holding the script font
 * and then Noto Sans, so a Japanese brief that mentions "Stripe" and an Arabic
 * one that names "Priya" get the Latin from a font that has it rather than a row
 * of blanks.
 */
@Component
public class PdfFonts {

    private static final String LATIN = "NotoSans-Regular.ttf";
    private static final String LATIN_BOLD = "NotoSans-Bold.ttf";

    /** Loaded once each; OpenPDF tracks per-document glyph use separately, so sharing is safe. */
    private final Map<String, BaseFont> faces = new ConcurrentHashMap<>();

    public Palette paletteFor(Language language) {
        if (language == null) {
            return latinOnly();
        }
        return switch (language) {
            case ARABIC -> embedded("NotoSansArabic-Regular.ttf", "NotoSansArabic-Bold.ttf");
            case HEBREW -> embedded("NotoSansHebrew-Regular.ttf", "NotoSansHebrew-Bold.ttf");
            case HINDI -> embedded("NotoSansDevanagari-Regular.ttf", "NotoSansDevanagari-Bold.ttf");
            // W5 is already a medium weight and Adobe-GB1 offers no bold, so
            // headings in these two are told apart by size rather than weight.
            case JAPANESE -> cjk("HeiseiKakuGo-W5", "UniJIS-UCS2-H");
            case CHINESE -> cjk("STSong-Light", "UniGB-UCS2-H");
            default -> latinOnly();
        };
    }

    private Palette latinOnly() {
        BaseFont regular = load(LATIN);
        BaseFont bold = load(LATIN_BOLD);
        return new Palette(regular, bold, regular, bold);
    }

    private Palette embedded(String regular, String bold) {
        return new Palette(load(regular), load(bold), load(LATIN), load(LATIN_BOLD));
    }

    private Palette cjk(String name, String encoding) {
        BaseFont face = faces.computeIfAbsent(name, key -> {
            try {
                return BaseFont.createFont(key, encoding, BaseFont.NOT_EMBEDDED);
            } catch (DocumentException e) {
                throw new IllegalStateException("Could not load the CJK font " + key, e);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        });
        return new Palette(face, face, load(LATIN), load(LATIN_BOLD));
    }

    private BaseFont load(String file) {
        return faces.computeIfAbsent(file, key -> {
            try (InputStream in = PdfFonts.class.getResourceAsStream("/fonts/" + key)) {
                if (in == null) {
                    throw new IllegalStateException("Missing bundled font /fonts/" + key);
                }
                // IDENTITY_H is what makes the font a Unicode one rather than a
                // 256-character one; EMBEDDED puts a subset in every PDF, so the
                // file is readable on a machine that has never heard of Noto.
                return BaseFont.createFont(key, BaseFont.IDENTITY_H, BaseFont.EMBEDDED,
                        BaseFont.CACHED, in.readAllBytes(), null);
            } catch (DocumentException e) {
                throw new IllegalStateException("Could not load the bundled font " + key, e);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        });
    }

    /**
     * The faces one document is written in, and the means to ask for text at a
     * given size and weight.
     */
    public record Palette(BaseFont script, BaseFont scriptBold, BaseFont latin, BaseFont latinBold) {

        /**
         * A selector that renders each character in the first of these fonts
         * that actually has the glyph — the script font, then Noto Sans.
         */
        public FontSelector at(float size, boolean bold, Color colour) {
            FontSelector selector = new FontSelector();
            selector.addFont(new Font(bold ? scriptBold : script, size, Font.NORMAL, colour));
            if (latin != script) {
                selector.addFont(new Font(bold ? latinBold : latin, size, Font.NORMAL, colour));
            }
            return selector;
        }

        /** The plain Latin face, for the things that are never translated — page numbers. */
        public Font plain(float size, Color colour) {
            return new Font(latin, size, Font.NORMAL, colour);
        }
    }
}
