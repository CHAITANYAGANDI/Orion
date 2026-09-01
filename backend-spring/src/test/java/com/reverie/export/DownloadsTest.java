package com.reverie.export;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * What the downloaded file is called.
 *
 * <p>Small surface, and every test here is a thing that breaks a download rather
 * than merely making it look untidy: a slash in a title is a path, a quote in a
 * header ends the header early, and a Japanese title sent in a Latin-1 header
 * arrives as nothing at all.
 */
class DownloadsTest {

    @Nested
    @DisplayName("slug")
    class Slug {

        @Test
        void makesAFilenameOutOfATitle() {
            assertThat(Downloads.slug("Q3 Planning — Billing & Growth"))
                    .isEqualTo("q3-planning-billing-growth");
        }

        @Test
        void keepsATitleThatIsNotLatin() {
            // Stripping to ASCII would name every Japanese meeting "meeting",
            // and a downloads folder of them is unusable.
            assertThat(Downloads.slug("四半期レビュー")).isEqualTo("四半期レビュー");
        }

        @Test
        void removesEverythingAFilesystemObjectsTo() {
            assertThat(Downloads.slug("Budget: 50/50 split? \"final\""))
                    .isEqualTo("budget-50-50-split-final");
        }

        @Test
        void fallsBackWhenThereIsNothingUsableLeft() {
            assertThat(Downloads.slug("!!! ???")).isEqualTo("meeting");
            assertThat(Downloads.slug("")).isEqualTo("meeting");
            assertThat(Downloads.slug(null)).isEqualTo("meeting");
        }

        @Test
        void staysShortEnoughToBeAFilename() {
            assertThat(Downloads.slug("word ".repeat(60))).hasSizeLessThanOrEqualTo(60);
        }
    }

    @Nested
    @DisplayName("Content-Disposition")
    class Disposition {

        @Test
        void namesTheFileTwice() {
            String header = Downloads.attachment("sprint-planning.pdf");

            // Both spellings: the plain one for anything that does not read
            // RFC 5987, the starred one for everything since about 2011.
            assertThat(header).isEqualTo(
                    "attachment; filename=\"sprint-planning.pdf\"; filename*=UTF-8''sprint-planning.pdf");
        }

        @Test
        void percentEncodesANameTheHeaderCannotCarry() {
            String header = Downloads.attachment("四半期.docx");

            assertThat(header).contains("filename*=UTF-8''%E5%9B%9B%E5%8D%8A%E6%9C%9F.docx");
        }

        @Test
        void keepsAReadableFallbackWhenNothingLatinSurvives() {
            String header = Downloads.attachment("四半期.docx");

            // A fallback of "" or "." is a browser saving the file as "download";
            // the extension at least tells it what it is holding.
            assertThat(header).startsWith("attachment; filename=\"meeting.docx\"");
        }

        @Test
        void neverLetsANameCloseTheHeaderEarly() {
            String header = Downloads.attachment("a\"b.txt");

            assertThat(header).startsWith("attachment; filename=\"ab.txt\"");
        }

        @Test
        void encodesASpaceAsAnEscapeRatherThanAPlus() {
            // URLEncoder writes "+", which RFC 5987 reads as a literal plus:
            // "my notes.txt" would download as "my+notes.txt".
            assertThat(Downloads.attachment("my notes.txt")).contains("filename*=UTF-8''my%20notes.txt");
        }
    }
}
