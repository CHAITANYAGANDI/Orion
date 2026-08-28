package com.orion.export;

import com.orion.domain.ExportFormat;
import com.orion.domain.Language;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Word, written as OOXML.
 *
 * <p><strong>Why there is no library here.</strong> A {@code .docx} is a zip of
 * five small XML files, and this renderer emits a linear document — headings,
 * paragraphs, lists, a checklist. Apache POI would do it, at the cost of
 * {@code poi-ooxml} plus {@code xmlbeans} and their dependencies, which is on
 * the order of twenty megabytes of jars to produce a file whose entire grammar
 * is used below. The parts that make OOXML genuinely hard — tables that break
 * across pages, embedded media, tracked changes, reading a document somebody
 * else wrote — are not things this does.
 *
 * <p><strong>Why it is a real Word document and not RTF or HTML-in-a-.doc.</strong>
 * Because it gets edited. Bullets are list items, headings are heading styles,
 * so the navigation pane works and somebody rewriting the minutes into their own
 * template gets structure rather than a wall of manually indented text.
 *
 * <p>Right-to-left is a matter of saying so — {@code w:bidi} on the section and
 * on each paragraph, {@code w:rtl} on each run — and then Word does the
 * bidirectional layout and the Arabic joining itself. This is the one format
 * where the hard typography is somebody else's problem.
 */
@Component
public class DocxRenderer implements DocumentRenderer {

    /**
     * A fixed timestamp on every zip entry.
     *
     * <p>Exporting the same meeting twice should produce the same bytes; the
     * current time in the entry headers is the only thing that would otherwise
     * stop it, and a build that is reproducible is a build whose output can be
     * compared in a test.
     */
    private static final long EPOCH = 0L;

    private static final String W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    private static final String RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
    private static final String OFFICE_RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

    @Override
    public ExportFormat format() {
        return ExportFormat.DOCX;
    }

    @Override
    public byte[] render(ExportDocument doc) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes, StandardCharsets.UTF_8)) {
            // Content types first: it is the manifest, and some readers refuse a
            // package that does not open with it.
            put(zip, "[Content_Types].xml", contentTypes());
            put(zip, "_rels/.rels", packageRels());
            put(zip, "docProps/core.xml", coreProperties(doc));
            put(zip, "word/_rels/document.xml.rels", documentRels());
            put(zip, "word/styles.xml", styles(doc));
            put(zip, "word/numbering.xml", numbering());
            put(zip, "word/document.xml", document(doc));
        } catch (IOException e) {
            throw new UncheckedIOException("Could not write the Word document", e);
        }
        return bytes.toByteArray();
    }

    /* ------------------------------- the body ----------------------------- */

    private String document(ExportDocument doc) {
        StringBuilder body = new StringBuilder();

        body.append(paragraph(doc, "Title", run(doc, doc.title(), null)));
        if (!doc.meta().isEmpty()) {
            body.append(paragraph(doc, "Subtitle", run(doc, String.join(" · ", doc.meta()), null)));
        }
        if (doc.notice() != null) {
            body.append(paragraph(doc, "Notice", run(doc, doc.notice(), null)));
        }

        for (ExportDocument.Block block : doc.blocks()) {
            switch (block) {
                case ExportDocument.Block.Heading h ->
                        body.append(paragraph(doc, h.level() == 1 ? "Heading1" : "Heading2",
                                run(doc, h.text(), null)));
                case ExportDocument.Block.Prose p -> {
                    for (String paragraph : p.text().split("\n\n+")) {
                        if (!paragraph.isBlank()) {
                            body.append(paragraph(doc, null, runs(doc, paragraph.strip(), null)));
                        }
                    }
                }
                case ExportDocument.Block.Aside a ->
                        body.append(paragraph(doc, "Notice", run(doc, a.text(), null)));
                case ExportDocument.Block.Bullets b -> {
                    for (String item : b.items()) {
                        body.append(paragraph(doc, "ListParagraph", run(doc, item, null),
                                "<w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr>"));
                    }
                }
                case ExportDocument.Block.Tasks t -> {
                    for (ExportDocument.Task task : t.items()) {
                        StringBuilder content = new StringBuilder();
                        content.append(run(doc, (task.done() ? "☑" : "☐") + "  ", null));
                        content.append(run(doc, task.title(), "<w:b/>"));
                        if (!task.detail().isBlank()) {
                            content.append(run(doc, "  " + task.detail(), "<w:color w:val=\"5F6368\"/>"));
                        }
                        body.append(paragraph(doc, null, content.toString(),
                                "<w:ind w:" + start(doc) + "=\"360\" w:hanging=\"360\"/>"));
                    }
                }
                case ExportDocument.Block.Transcript t -> {
                    for (ExportDocument.Utterance line : t.lines()) {
                        StringBuilder content = new StringBuilder();
                        // Each part only when the export asked for it; a bold
                        // empty run still costs a stray double space.
                        if (line.timecode() != null && !line.timecode().isBlank()) {
                            content.append(run(doc, "[" + line.timecode() + "]  ",
                                    "<w:color w:val=\"8A8F98\"/>"));
                        }
                        if (line.speaker() != null && !line.speaker().isBlank()) {
                            content.append(run(doc, line.speaker() + "  ", "<w:b/>"));
                        }
                        content.append(runs(doc, line.text(), null));
                        // A hanging indent so a long utterance wraps against the
                        // words rather than back under the speaker's name.
                        body.append(paragraph(doc, null, content.toString(),
                                "<w:spacing w:after=\"80\"/><w:ind w:" + start(doc)
                                        + "=\"1080\" w:hanging=\"1080\"/>"));
                    }
                }
            }
        }

        body.append(paragraph(doc, "Notice", run(doc, "Exported from Orion AI", null)));

        return """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <w:document xmlns:w="%s"><w:body>%s<w:sectPr>%s\
                <w:pgSz w:w="11906" w:h="16838"/>\
                <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/>\
                </w:sectPr></w:body></w:document>"""
                .formatted(W, body, doc.rightToLeft() ? "<w:bidi/>" : "");
    }

    /** {@code w:left}/{@code w:right} are physical; indentation has to follow the script. */
    private static String start(ExportDocument doc) {
        return doc.rightToLeft() ? "right" : "left";
    }

    private String paragraph(ExportDocument doc, String style, String content) {
        return paragraph(doc, style, content, "");
    }

    private String paragraph(ExportDocument doc, String style, String content, String extraProps) {
        String props = (style == null ? "" : "<w:pStyle w:val=\"" + style + "\"/>")
                + extraProps
                + (doc.rightToLeft() ? "<w:bidi/>" : "");
        return "<w:p>" + (props.isEmpty() ? "" : "<w:pPr>" + props + "</w:pPr>") + content + "</w:p>";
    }

    /** One run. {@code props} is any extra {@code w:rPr} children, or null. */
    private String run(ExportDocument doc, String text, String props) {
        String rPr = (props == null ? "" : props) + (doc.rightToLeft() ? "<w:rtl/>" : "");
        return "<w:r>"
                + (rPr.isEmpty() ? "" : "<w:rPr>" + rPr + "</w:rPr>")
                + "<w:t xml:space=\"preserve\">" + escape(text) + "</w:t></w:r>";
    }

    /** Runs for text that may contain single newlines, which become line breaks. */
    private String runs(ExportDocument doc, String text, String props) {
        String[] lines = text.split("\n", -1);
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < lines.length; i++) {
            if (i > 0) {
                out.append("<w:r><w:br/></w:r>");
            }
            out.append(run(doc, lines[i], props));
        }
        return out.toString();
    }

    /* ------------------------------ the parts ----------------------------- */

    private String contentTypes() {
        return """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\
                <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\
                <Default Extension="xml" ContentType="application/xml"/>\
                <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\
                <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>\
                <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>\
                <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>\
                </Types>""";
    }

    private String packageRels() {
        return """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <Relationships xmlns="%s">\
                <Relationship Id="rId1" Type="%s/officeDocument" Target="word/document.xml"/>\
                <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>\
                </Relationships>""".formatted(RELS, OFFICE_RELS);
    }

    private String documentRels() {
        return """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <Relationships xmlns="%s">\
                <Relationship Id="rId1" Type="%s/styles" Target="styles.xml"/>\
                <Relationship Id="rId2" Type="%s/numbering" Target="numbering.xml"/>\
                </Relationships>""".formatted(RELS, OFFICE_RELS, OFFICE_RELS);
    }

    private String coreProperties(ExportDocument doc) {
        return """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" \
                xmlns:dc="http://purl.org/dc/elements/1.1/">\
                <dc:title>%s</dc:title>\
                <dc:creator>Orion AI</dc:creator>\
                <cp:lastModifiedBy>Orion AI</cp:lastModifiedBy>\
                </cp:coreProperties>""".formatted(escape(doc.title()));
    }

    /**
     * The stylesheet.
     *
     * <p>{@code w:sz} is in half-points, and {@code w:lang} is what tells Word
     * which dictionary to spell-check against — a Spanish document flagged as
     * English is underlined in red from end to end, which reads as a broken
     * export rather than as a missing attribute.
     */
    private String styles(ExportDocument doc) {
        return """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <w:styles xmlns:w="%s">\
                <w:docDefaults><w:rPrDefault><w:rPr>\
                <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>\
                <w:sz w:val="22"/><w:szCs w:val="22"/>%s\
                </w:rPr></w:rPrDefault>\
                <w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>\
                </w:docDefaults>\
                <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>\
                <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>\
                <w:pPr><w:spacing w:after="40"/></w:pPr>\
                <w:rPr><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>\
                <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/>\
                <w:pPr><w:spacing w:after="240"/></w:pPr>\
                <w:rPr><w:color w:val="5F6368"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>\
                <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>\
                <w:pPr><w:keepNext/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>\
                <w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>\
                <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>\
                <w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr>\
                <w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>\
                <w:style w:type="paragraph" w:styleId="Notice"><w:name w:val="Notice"/><w:basedOn w:val="Normal"/>\
                <w:rPr><w:i/><w:color w:val="5F6368"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>\
                <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>\
                <w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>\
                </w:styles>""".formatted(W, languageTag(doc.language()));
    }

    /**
     * Word's three language slots, one per script class.
     *
     * <p>Setting {@code w:val} for Arabic would tell Word the Latin text is
     * Arabic, which is not what is meant; the bidi slot is the one that governs
     * a right-to-left script, and East Asian has a slot of its own.
     */
    private static String languageTag(Language language) {
        if (language == null) {
            return "";
        }
        String slot = language.rightToLeft() ? "w:bidi"
                : (language == Language.JAPANESE || language == Language.CHINESE) ? "w:eastAsia"
                : "w:val";
        return "<w:lang " + slot + "=\"" + language.code() + "\"/>";
    }

    private String numbering() {
        return """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <w:numbering xmlns:w="%s">\
                <w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>\
                <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>\
                <w:lvlText w:val="•"/><w:lvlJc w:val="left"/>\
                <w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl>\
                </w:abstractNum>\
                <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>\
                </w:numbering>""".formatted(W);
    }

    /* ------------------------------- plumbing ----------------------------- */

    private static void put(ZipOutputStream zip, String name, String xml) throws IOException {
        ZipEntry entry = new ZipEntry(name);
        entry.setTime(EPOCH);
        zip.putNextEntry(entry);
        zip.write(xml.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }

    /**
     * XML text.
     *
     * <p>Control characters are dropped rather than escaped: XML 1.0 has no
     * representation for them at all, and a transcript that picked one up from
     * a provider would otherwise produce a file Word refuses to open with no
     * explanation of what is wrong with it.
     */
    static String escape(String text) {
        if (text == null) {
            return "";
        }
        StringBuilder out = new StringBuilder(text.length() + 16);
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '&' -> out.append("&amp;");
                case '<' -> out.append("&lt;");
                case '>' -> out.append("&gt;");
                case '"' -> out.append("&quot;");
                default -> {
                    if (c >= 0x20 || c == '\t' || c == '\n' || c == '\r') {
                        out.append(c);
                    }
                }
            }
        }
        return out.toString();
    }
}
