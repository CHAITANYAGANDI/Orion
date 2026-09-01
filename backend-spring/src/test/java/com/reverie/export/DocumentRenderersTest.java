package com.reverie.export;

import com.reverie.domain.Language;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.openpdf.text.pdf.PdfDictionary;
import org.openpdf.text.pdf.PdfName;
import org.openpdf.text.pdf.PdfObject;
import org.openpdf.text.pdf.PdfReader;
import org.openpdf.text.pdf.parser.PdfTextExtractor;
import org.w3c.dom.Document;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.entry;

/**
 * The four files a meeting can leave as.
 *
 * <p>The first group is the contract all four share, run against each of them:
 * whatever the format, the meeting's title, its decisions, its tasks and — when
 * asked for — its transcript have to be in the file. A format that quietly drops
 * a section is worse than one that fails, because the person holding it has no
 * way to know.
 *
 * <p>After that, one group per format for the things only that format can get
 * wrong: a PDF with no font for the script it is setting, a Word file that Word
 * will not open, a text file that is one line eleven thousand characters long.
 */
class DocumentRenderersTest {

    private static final PdfRenderer PDF = new PdfRenderer(new PdfFonts());
    private static final DocxRenderer DOCX = new DocxRenderer();
    private static final MarkdownRenderer MARKDOWN = new MarkdownRenderer();
    private static final TextRenderer TEXT = new TextRenderer();

    static Stream<DocumentRenderer> renderers() {
        return Stream.of(PDF, DOCX, MARKDOWN, TEXT);
    }

    /* ---------------------------- what they share --------------------------- */

    @ParameterizedTest(name = "{0}")
    @MethodSource("renderers")
    void writesTheWholeMeeting(DocumentRenderer renderer) throws Exception {
        String text = readable(renderer, renderer.render(sample(Language.ENGLISH)));

        assertThat(text)
                .contains("Sprint planning")
                .contains("Move billing to Stripe")
                .contains("Finish the JWT validation")
                .contains("Priya")
                .contains("Right, shall we start?");
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("renderers")
    void keepsASectionTheMeetingNeverReached(DocumentRenderer renderer) throws Exception {
        String text = readable(renderer, renderer.render(sample(Language.ENGLISH)));

        // The heading is the information: "Budget" with nothing under it says
        // budget never came up, which is not the same as a template that never
        // asked about budget.
        assertThat(text).contains("Budget").contains("Not discussed");
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("renderers")
    void saysWhichTasksAreDone(DocumentRenderer renderer) throws Exception {
        String text = readable(renderer, renderer.render(sample(Language.ENGLISH)));

        // An export is a working list, not a record of one. A file that shows
        // six things to do when two are finished is a file that gets acted on.
        String done = renderer.format() == com.reverie.domain.ExportFormat.DOCX ? "☑" : "[x]";
        String open = renderer.format() == com.reverie.domain.ExportFormat.DOCX ? "☐" : "[ ]";
        assertThat(text).contains(done).contains(open);
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("renderers")
    void producesAFileForEveryScriptTheProductWorksIn(DocumentRenderer renderer) {
        for (Language language : Language.all()) {
            byte[] file = renderer.render(sample(language));

            // Not a smoke test: a PDF has to carry a font for the script it is
            // setting, and the failure without one is an exception here or four
            // thousand empty boxes for the reader.
            assertThat(file).as("%s in %s", renderer.format(), language.englishName()).isNotEmpty();
        }
    }

    /* --------------------------------- PDF --------------------------------- */

    @Nested
    @DisplayName("PDF")
    class Pdf {

        @Test
        void isAPdf() {
            assertThat(new String(PDF.render(sample(Language.ENGLISH)), 0, 5, StandardCharsets.ISO_8859_1))
                    .isEqualTo("%PDF-");
        }

        @Test
        void setsJapaneseAgainstTheAdobeCollectionTheReaderResolves() throws IOException {
            byte[] file = PDF.render(japanese());

            // Japanese is not embedded — that is the whole reason this repository
            // does not carry a sixteen-megabyte font — so what has to be right is
            // the reference: the character collection and the encoding are what a
            // reader uses to find its own glyphs. Get either wrong and the file
            // opens to a page of nothing with no error anywhere.
            assertThat(fontsOnFirstPage(file))
                    .contains(entry("HeiseiKakuGo-W5-UniJIS-UCS2-H", "UniJIS-UCS2-H"));
        }

        @Test
        void embedsALatinFontAlongsideItForTheWordsThatAreNotJapanese() throws IOException {
            // The same page carries a subset of Noto Sans, which is what renders
            // "Stripe" in the middle of a Japanese bullet. Without it the CID
            // font would be asked for Latin it may not have.
            assertThat(fontsOnFirstPage(PDF.render(japanese())).values()).contains("Identity-H");
        }

        @Test
        void putsTheJapaneseWordsInThePage() throws IOException {
            byte[] file = PDF.render(japanese());

            // UniJIS-UCS2-H is indexed by the Unicode code point itself, so the
            // content stream carries the characters as UTF-16 — which is also
            // what makes them checkable without a font to render them with.
            PdfReader reader = new PdfReader(file);
            String page = new String(reader.getPageContent(1), StandardCharsets.ISO_8859_1);
            String utf16 = new String("四半期レビュー".getBytes(StandardCharsets.UTF_16BE),
                    StandardCharsets.ISO_8859_1);
            assertThat(page).contains(utf16);
        }

        @Test
        void setsArabicInAFontThatHasArabic() throws IOException {
            String text = pdfText(PDF.render(arabic()));

            assertThat(text).contains("اجتماع");
        }

        @Test
        void findsLatinWordsInsideAScriptWithNoLatinInIt() throws IOException {
            // Noto Sans Arabic has no letter A. Without the fallback every
            // product name and every person's name in an Arabic export would be
            // a run of blanks.
            String text = pdfText(PDF.render(arabic()));

            assertThat(text).contains("Stripe");
        }

        @Test
        void runsToMorePagesWhenThereIsMoreToSay() throws IOException {
            List<ExportDocument.Utterance> many = new ArrayList<>();
            for (int i = 0; i < 200; i++) {
                many.add(new ExportDocument.Utterance("0:" + String.format("%02d", i % 60), "Priya",
                        "We should probably talk about the billing migration again."));
            }
            byte[] file = PDF.render(new ExportDocument("Long one", List.of(), null, Language.ENGLISH,
                    List.of(new ExportDocument.Block.Transcript(many))));

            PdfReader reader = new PdfReader(file);
            assertThat(reader.getNumberOfPages()).isGreaterThan(1);
        }
    }

    /* --------------------------------- DOCX -------------------------------- */

    @Nested
    @DisplayName("DOCX")
    class Docx {

        @Test
        void isAPackageWordCanOpen() throws Exception {
            Map<String, byte[]> parts = unzip(DOCX.render(sample(Language.ENGLISH)));

            assertThat(parts).containsKeys("[Content_Types].xml", "_rels/.rels",
                    "word/document.xml", "word/styles.xml", "word/numbering.xml",
                    "word/_rels/document.xml.rels", "docProps/core.xml");
        }

        @Test
        void opensWithItsOwnManifest() throws Exception {
            // Some readers, Word among them in its stricter moods, want the
            // content types first in the archive rather than merely present.
            try (ZipInputStream zip = new ZipInputStream(
                    new ByteArrayInputStream(DOCX.render(sample(Language.ENGLISH))))) {
                assertThat(zip.getNextEntry().getName()).isEqualTo("[Content_Types].xml");
            }
        }

        @Test
        void writesXmlThatParses() throws Exception {
            for (Map.Entry<String, byte[]> part : unzip(DOCX.render(sample(Language.ENGLISH))).entrySet()) {
                assertThat(parse(part.getValue())).as(part.getKey()).isNotNull();
            }
        }

        @Test
        void survivesATranscriptFullOfAngleBrackets() throws Exception {
            ExportDocument doc = new ExportDocument("A & B <c>", List.of(), null, Language.ENGLISH,
                    List.of(new ExportDocument.Block.Prose("5 < 6 && \"quoted\"")));

            Map<String, byte[]> parts = unzip(DOCX.render(doc));
            assertThat(parse(parts.get("word/document.xml"))).isNotNull();
            assertThat(new String(parts.get("word/document.xml"), StandardCharsets.UTF_8))
                    .contains("5 &lt; 6 &amp;&amp;");
        }

        @Test
        void dropsCharactersXmlCannotHold() throws Exception {
            // A control character from a provider would make a file Word refuses
            // to open, with a message that says nothing about which character.
            ExportDocument doc = new ExportDocument("Fine", List.of(), null, Language.ENGLISH,
                    List.of(new ExportDocument.Block.Prose("before" + (char) 7 + "after")));

            Map<String, byte[]> parts = unzip(DOCX.render(doc));
            assertThat(parse(parts.get("word/document.xml"))).isNotNull();
            assertThat(new String(parts.get("word/document.xml"), StandardCharsets.UTF_8))
                    .contains("beforeafter");
        }

        @Test
        void makesBulletsRealListItems() throws Exception {
            String xml = new String(unzip(DOCX.render(sample(Language.ENGLISH))).get("word/document.xml"),
                    StandardCharsets.UTF_8);

            // Not "• " typed into a paragraph: somebody rewriting these minutes
            // in Word should get a list that behaves like one.
            assertThat(xml).contains("<w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr>");
        }

        @Test
        void tellsWordThatArabicRunsTheOtherWay() throws Exception {
            String xml = new String(unzip(DOCX.render(arabic())).get("word/document.xml"),
                    StandardCharsets.UTF_8);

            assertThat(xml).contains("<w:bidi/>").contains("<w:rtl/>");
        }

        @Test
        void leavesALatinDocumentAlone() throws Exception {
            String xml = new String(unzip(DOCX.render(sample(Language.ENGLISH))).get("word/document.xml"),
                    StandardCharsets.UTF_8);

            assertThat(xml).doesNotContain("<w:bidi/>").doesNotContain("<w:rtl/>");
        }

        @Test
        void spellChecksInTheLanguageItIsWrittenIn() throws Exception {
            String styles = new String(unzip(DOCX.render(sample(Language.SPANISH))).get("word/styles.xml"),
                    StandardCharsets.UTF_8);

            // Without this the whole document is underlined in red, which reads
            // as a broken export rather than as a missing attribute.
            assertThat(styles).contains("<w:lang w:val=\"es\"/>");
        }

        @Test
        void isTheSameFileTwiceOver() {
            // Zip entry timestamps default to "now", which would make every
            // export of an unchanged meeting a different file.
            assertThat(DOCX.render(sample(Language.ENGLISH)))
                    .isEqualTo(DOCX.render(sample(Language.ENGLISH)));
        }
    }

    /* --------------------------------- text -------------------------------- */

    @Nested
    @DisplayName("plain text")
    class Text {

        @Test
        void wrapsSoThatNotepadCanReadIt() {
            String out = new String(TEXT.render(new ExportDocument("Long", List.of(), null,
                    Language.ENGLISH,
                    List.of(new ExportDocument.Block.Prose("word ".repeat(400))))),
                    StandardCharsets.UTF_8);

            assertThat(out.lines().map(String::length).max(Integer::compareTo).orElseThrow())
                    .isLessThanOrEqualTo(78);
        }

        @Test
        void breaksJapaneseWhereThereAreNoSpacesToBreakOn() {
            String out = new String(TEXT.render(new ExportDocument("Long", List.of(), null,
                    Language.JAPANESE,
                    List.of(new ExportDocument.Block.Prose("四半期".repeat(120))))),
                    StandardCharsets.UTF_8);

            // No spaces anywhere, so a wrap that only breaks on whitespace
            // produces one line of 360 double-width characters.
            assertThat(out.lines().count()).isGreaterThan(5);
            assertThat(out.lines().map(String::length).max(Integer::compareTo).orElseThrow())
                    .isLessThanOrEqualTo(78);
        }

        @Test
        void underlinesHeadingsRatherThanShoutingThem() {
            String out = new String(TEXT.render(sample(Language.ENGLISH)), StandardCharsets.UTF_8);

            // Upper-casing is a locale-dependent edit of somebody's words; a
            // rule of dashes reads the same in every script.
            assertThat(out).contains("Decisions\n---------");
            assertThat(out).doesNotContain("DECISIONS");
        }

        @Test
        void marksTasksInAsciiThatEveryEditorHas() {
            String out = new String(TEXT.render(sample(Language.ENGLISH)), StandardCharsets.UTF_8);

            assertThat(out).contains("[ ] Finish the JWT validation");
            assertThat(out).contains("[x] Draft the rollout plan");
        }
    }

    /* ------------------------------- markdown ------------------------------ */

    @Nested
    @DisplayName("markdown")
    class Markdown {

        @Test
        void writesCheckboxesGitHubUnderstands() {
            String out = new String(MARKDOWN.render(sample(Language.ENGLISH)), StandardCharsets.UTF_8);

            assertThat(out).contains("- [ ] Finish the JWT validation");
            assertThat(out).contains("- [x] Draft the rollout plan");
        }

        @Test
        void nestsHeadingsUnderTheTitle() {
            String out = new String(MARKDOWN.render(sample(Language.ENGLISH)), StandardCharsets.UTF_8);

            assertThat(out).startsWith("# Sprint planning");
            assertThat(out).contains("## Decisions");
            assertThat(out).contains("### Billing");
        }
    }

    /* ------------------------------- fixtures ------------------------------ */

    /**
     * A meeting with one of everything: a bulleted section, an outline, a
     * section nobody reached, two tasks in different states, and a transcript.
     */
    private static ExportDocument sample(Language language) {
        return new ExportDocument(
                "Sprint planning",
                List.of("16 August 2026 at 10:04", "42 min"),
                null,
                language,
                List.of(
                        new ExportDocument.Block.Heading(1, "Decisions"),
                        new ExportDocument.Block.Bullets(List.of("Move billing to Stripe")),
                        new ExportDocument.Block.Heading(1, "Walkthrough"),
                        new ExportDocument.Block.Heading(2, "Billing"),
                        new ExportDocument.Block.Bullets(List.of("Stripe won on fees")),
                        new ExportDocument.Block.Heading(1, "Budget"),
                        new ExportDocument.Block.Aside("Not discussed."),
                        new ExportDocument.Block.Heading(1, "Action items"),
                        new ExportDocument.Block.Tasks(List.of(
                                new ExportDocument.Task(false, "Finish the JWT validation",
                                        "Priya · due friday · high"),
                                new ExportDocument.Task(true, "Draft the rollout plan",
                                        "Marcus · due before the demo"))),
                        new ExportDocument.Block.Heading(1, "Transcript"),
                        new ExportDocument.Block.Transcript(List.of(
                                new ExportDocument.Utterance("0:00", "Priya", "Right, shall we start?"),
                                new ExportDocument.Utterance("15:42", "Marcus",
                                        "I'll draft the rollout plan before the demo.")))));
    }

    private static ExportDocument japanese() {
        return new ExportDocument("四半期レビュー", List.of("42分"), null, Language.JAPANESE,
                List.of(new ExportDocument.Block.Heading(1, "要点"),
                        new ExportDocument.Block.Bullets(List.of("請求をStripeに移行する"))));
    }

    private static ExportDocument arabic() {
        return new ExportDocument("اجتماع التخطيط", List.of("42 دقيقة"),
                "Translated into Arabic.", Language.ARABIC,
                List.of(new ExportDocument.Block.Heading(1, "القرارات"),
                        new ExportDocument.Block.Bullets(List.of("نقل الفوترة إلى Stripe"))));
    }

    /* -------------------------------- reading ------------------------------ */

    /** Whatever the format, as text a test can make assertions about. */
    private static String readable(DocumentRenderer renderer, byte[] file) throws Exception {
        return switch (renderer.format()) {
            case PDF -> pdfText(file);
            case DOCX -> new String(unzip(file).get("word/document.xml"), StandardCharsets.UTF_8);
            case MARKDOWN, TXT -> new String(file, StandardCharsets.UTF_8);
        };
    }

    /** Each font the first page uses, as base name to encoding. */
    private static Map<String, String> fontsOnFirstPage(byte[] file) throws IOException {
        PdfReader reader = new PdfReader(file);
        PdfDictionary fonts = reader.getPageN(1)
                .getAsDict(PdfName.RESOURCES)
                .getAsDict(PdfName.FONT);
        Map<String, String> used = new HashMap<>();
        for (PdfName key : fonts.getKeys()) {
            PdfDictionary font = fonts.getAsDict(key);
            PdfObject base = font.get(PdfName.BASEFONT);
            PdfObject encoding = font.get(PdfName.ENCODING);
            used.put(base == null ? "?" : PdfName.decodeName(base.toString()),
                    encoding == null ? "" : PdfName.decodeName(encoding.toString()));
        }
        return used;
    }

    private static String pdfText(byte[] file) throws IOException {
        PdfReader reader = new PdfReader(file);
        PdfTextExtractor extractor = new PdfTextExtractor(reader);
        StringBuilder out = new StringBuilder();
        for (int page = 1; page <= reader.getNumberOfPages(); page++) {
            out.append(extractor.getTextFromPage(page)).append('\n');
        }
        return out.toString();
    }

    private static Map<String, byte[]> unzip(byte[] file) throws IOException {
        Map<String, byte[]> parts = new HashMap<>();
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(file))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                parts.put(entry.getName(), zip.readAllBytes());
            }
        }
        return parts;
    }

    private static Document parse(byte[] xml) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        factory.setNamespaceAware(true);
        return factory.newDocumentBuilder().parse(new ByteArrayInputStream(xml));
    }
}
