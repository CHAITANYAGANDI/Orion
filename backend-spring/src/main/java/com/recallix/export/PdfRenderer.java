package com.recallix.export;

import com.recallix.domain.ExportFormat;
import org.openpdf.text.Document;
import org.openpdf.text.DocumentException;
import org.openpdf.text.Element;
import org.openpdf.text.Font;
import org.openpdf.text.PageSize;
import org.openpdf.text.Paragraph;
import org.openpdf.text.Phrase;
import org.openpdf.text.Rectangle;
import org.openpdf.text.pdf.ColumnText;
import org.openpdf.text.pdf.PdfPageEventHelper;
import org.openpdf.text.pdf.PdfWriter;
import org.springframework.stereotype.Component;

import java.awt.Color;
import java.io.ByteArrayOutputStream;

/**
 * PDF — the one you attach to an email.
 *
 * <p>Laid out as flowing text rather than drawn, which is why this uses OpenPDF
 * and not a lower-level PDF writer: paragraphs wrap, pages break where they
 * should, and — the part that actually mattered — Arabic and Hebrew are laid out
 * right to left with the Arabic letters joined, from setting a run direction.
 * Doing that by hand is a bidirectional-algorithm implementation, not an export
 * feature.
 *
 * <p>Which fonts the text is set in, and why a Japanese meeting is not four
 * thousand empty boxes, is {@link PdfFonts}.
 *
 * <p>Action items are marked {@code [ ]} and {@code [x]} rather than with ballot
 * boxes. Not a style choice: U+2610 is absent from Noto Sans and from both Adobe
 * CJK collections, and a checkbox nobody's font can draw is a blank space where
 * the state of the task should be.
 */
@Component
public class PdfRenderer implements DocumentRenderer {

    private static final Color INK = new Color(0x1F, 0x23, 0x28);
    private static final Color MUTED = new Color(0x5F, 0x63, 0x68);
    private static final Color FAINT = new Color(0x8A, 0x8F, 0x98);

    private static final float BODY = 10.5f;

    private final PdfFonts fonts;

    public PdfRenderer(PdfFonts fonts) {
        this.fonts = fonts;
    }

    @Override
    public ExportFormat format() {
        return ExportFormat.PDF;
    }

    @Override
    public byte[] render(ExportDocument doc) {
        PdfFonts.Palette palette = fonts.paletteFor(doc.language());
        boolean rtl = doc.rightToLeft();
        ByteArrayOutputStream out = new ByteArrayOutputStream();

        Document pdf = new Document(PageSize.A4, 56, 56, 54, 62);
        try {
            PdfWriter writer = PdfWriter.getInstance(pdf, out);
            // Set on the writer and again on every paragraph: the writer's is
            // what governs the columns it lays out internally, the paragraph's
            // is what survives being handed around, and being wrong here means
            // an Arabic document printed backwards.
            writer.setRunDirection(rtl ? PdfWriter.RUN_DIRECTION_RTL : PdfWriter.RUN_DIRECTION_LTR);
            writer.setPageEvent(new Footer(palette.plain(8f, FAINT)));

            pdf.addTitle(doc.title());
            pdf.addCreator("Recallix AI");
            pdf.open();

            write(pdf, doc, text(palette, doc.title(), 19f, true, INK), 0, 4, 0);
            if (!doc.meta().isEmpty()) {
                write(pdf, doc, text(palette, String.join("  ·  ", doc.meta()), 8.5f, false, MUTED),
                        0, 2, 0);
            }
            if (doc.notice() != null) {
                write(pdf, doc, text(palette, doc.notice(), 8.5f, false, MUTED), 4, 0, 0);
            }

            for (ExportDocument.Block block : doc.blocks()) {
                switch (block) {
                    case ExportDocument.Block.Heading h -> {
                        boolean top = h.level() == 1;
                        write(pdf, doc, text(palette, h.text(), top ? 14f : 11.5f, true, INK),
                                top ? 20 : 12, top ? 7 : 4, top ? 0 : 8);
                    }
                    case ExportDocument.Block.Prose p -> {
                        for (String paragraph : p.text().split("\n\n+")) {
                            if (!paragraph.isBlank()) {
                                write(pdf, doc, text(palette, paragraph.strip().replace('\n', ' '),
                                        BODY, false, INK), 0, 8, 0);
                            }
                        }
                    }
                    case ExportDocument.Block.Aside a ->
                            write(pdf, doc, text(palette, a.text(), 9.5f, false, FAINT), 0, 8, 0);
                    case ExportDocument.Block.Bullets b -> {
                        for (String item : b.items()) {
                            Paragraph p = write(pdf, doc,
                                    text(palette, "•   " + item, BODY, false, INK), 0, 4, 16);
                            p.setFirstLineIndent(-11);
                        }
                    }
                    case ExportDocument.Block.Tasks t -> {
                        for (ExportDocument.Task task : t.items()) {
                            Paragraph p = new Paragraph();
                            p.add(text(palette, task.done() ? "[x]   " : "[ ]   ", BODY, false, FAINT));
                            p.add(text(palette, task.title(), BODY, true, task.done() ? MUTED : INK));
                            if (!task.detail().isBlank()) {
                                p.add(text(palette, "   " + task.detail(), 9f, false, MUTED));
                            }
                            style(p, doc, 0, 5, 24);
                            p.setFirstLineIndent(-24);
                            pdf.add(p);
                        }
                    }
                    case ExportDocument.Block.Transcript t -> {
                        for (ExportDocument.Utterance line : t.lines()) {
                            Paragraph p = new Paragraph();
                            // Each part only when the export asked for it, so a
                            // transcript with neither is a clean block of prose
                            // rather than one indented by two empty runs.
                            if (line.timecode() != null && !line.timecode().isBlank()) {
                                p.add(text(palette, line.timecode() + "   ", 8.5f, false, FAINT));
                            }
                            if (line.speaker() != null && !line.speaker().isBlank()) {
                                p.add(text(palette, line.speaker() + "   ", BODY, true, INK));
                            }
                            p.add(text(palette, line.text(), BODY, false, INK));
                            style(p, doc, 0, 6, 0);
                            pdf.add(p);
                        }
                    }
                }
            }

            pdf.close();
        } catch (DocumentException e) {
            throw new IllegalStateException("Could not write the PDF", e);
        }
        return out.toByteArray();
    }

    /* ------------------------------- layout ------------------------------- */

    /** Text in the document's script, falling back to Latin per character. */
    private static Phrase text(PdfFonts.Palette palette, String content,
                               float size, boolean bold, Color colour) {
        return palette.at(size, bold, colour).process(content == null ? "" : content);
    }

    private Paragraph write(Document pdf, ExportDocument doc, Phrase phrase,
                            float before, float after, float indent) throws DocumentException {
        Paragraph p = new Paragraph(phrase);
        style(p, doc, before, after, indent);
        pdf.add(p);
        return p;
    }

    /**
     * Spacing, leading and — the part that matters in Arabic and Hebrew — which
     * margin the text starts at and which way it runs.
     */
    private static void style(Paragraph p, ExportDocument doc,
                              float before, float after, float indent) {
        p.setLeading(0, 1.35f);
        p.setSpacingBefore(before);
        p.setSpacingAfter(after);
        if (doc.rightToLeft()) {
            p.setRunDirection(PdfWriter.RUN_DIRECTION_RTL);
            p.setAlignment(Element.ALIGN_RIGHT);
            p.setIndentationRight(indent);
        } else {
            p.setRunDirection(PdfWriter.RUN_DIRECTION_LTR);
            p.setAlignment(Element.ALIGN_LEFT);
            p.setIndentationLeft(indent);
        }
    }

    /**
     * The line at the foot of every page.
     *
     * <p>Always left-to-right and always in Latin, including in an Arabic
     * document: it is a page number and a product name, not part of the meeting.
     */
    private static final class Footer extends PdfPageEventHelper {

        private final Font font;

        private Footer(Font font) {
            this.font = font;
        }

        @Override
        public void onEndPage(PdfWriter writer, Document document) {
            Rectangle page = document.getPageSize();
            float y = page.getBottom(36);
            ColumnText.showTextAligned(writer.getDirectContent(), Element.ALIGN_LEFT,
                    new Phrase("Exported from Recallix AI", font), document.leftMargin(), y, 0);
            ColumnText.showTextAligned(writer.getDirectContent(), Element.ALIGN_RIGHT,
                    new Phrase(String.valueOf(writer.getPageNumber()), font),
                    page.getWidth() - document.rightMargin(), y, 0);
        }
    }
}
