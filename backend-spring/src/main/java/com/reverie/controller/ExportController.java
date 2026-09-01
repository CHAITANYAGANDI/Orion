package com.reverie.controller;

import com.reverie.common.ApiException;
import com.reverie.domain.ExportFormat;
import com.reverie.domain.ExportOptions;
import com.reverie.dto.AudioDownloadResponse;
import com.reverie.dto.AudioExportResponse;
import com.reverie.export.Downloads;
import com.reverie.export.ExportFile;
import com.reverie.security.SecurityUtils;
import com.reverie.service.ExportService;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Taking a meeting out of Reverie.
 *
 * <p>One endpoint for the four document formats rather than four endpoints,
 * because they differ in one parameter and nothing else — same meeting, same
 * options, same permissions — and the audio has an endpoint of its own because
 * it differs in everything: it is not rendered, it is not small, and it does not
 * come back through this service at all.
 */
@RestController
@RequestMapping("/api/v1/meetings/{id}")
public class ExportController {

    private final ExportService exports;

    public ExportController(ExportService exports) {
        this.exports = exports;
    }

    /**
     * The meeting as a file.
     *
     * <p>Every option defaults to what this endpoint did before it had any, so
     * a caller that passes only {@code format} still gets the summary, the
     * action items and no transcript. That matters more than it sounds: the
     * account-wide data export calls the same service, and so does anyone who
     * bookmarked a download URL.
     *
     * @param format      pdf, docx, md or txt
     * @param summary     include the brief
     * @param sections    which summary sections, by key, comma-separated; blank means all
     * @param actionItems include what people agreed to do
     * @param transcript  include the full transcript, which is usually most of the file
     * @param speakers    label each utterance with who said it
     * @param timestamps  label each utterance with when it was said
     * @param combine     none, speaker, or all — how much of the back-and-forth to flatten
     * @param language    read it in a language the meeting has already been translated into
     * @param tz          the reader's IANA time zone, so the date matches the app's
     */
    @GetMapping("/export")
    public ResponseEntity<byte[]> export(@PathVariable String id,
                                         @RequestParam(defaultValue = "pdf") String format,
                                         @RequestParam(defaultValue = "true") boolean summary,
                                         @RequestParam(required = false) String sections,
                                         @RequestParam(defaultValue = "true") boolean actionItems,
                                         @RequestParam(defaultValue = "false") boolean transcript,
                                         @RequestParam(defaultValue = "true") boolean speakers,
                                         @RequestParam(defaultValue = "true") boolean timestamps,
                                         @RequestParam(required = false) String combine,
                                         @RequestParam(required = false) String language,
                                         @RequestParam(required = false) String tz) {
        ExportFormat chosen = ExportFormat.find(format).orElseThrow(() -> ApiException.badRequest(
                "Unsupported export format. Reverie writes: "
                        + String.join(", ", Arrays.stream(ExportFormat.values())
                                .map(ExportFormat::extension).toList())));

        ExportOptions options = new ExportOptions(
                summary, keys(sections), actionItems, transcript,
                speakers, timestamps, ExportOptions.Combine.of(combine));

        ExportFile file = exports.render(
                SecurityUtils.currentUserId(), id, chosen, options, language, tz);

        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, file.mediaType())
                .header(HttpHeaders.CONTENT_DISPOSITION, Downloads.attachment(file.filename()))
                // Rendered from live data — a summary corrected a minute ago has
                // to be in the next download, not in the one after it.
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .body(file.content());
    }

    /** Section keys from a comma-separated parameter, blanks discarded. */
    private static Set<String> keys(String raw) {
        if (raw == null || raw.isBlank()) {
            return Set.of();
        }
        Set<String> keys = new LinkedHashSet<>();
        for (String part : raw.split(",")) {
            String key = part.trim();
            if (!key.isEmpty()) {
                keys.add(key);
            }
        }
        return keys;
    }

    /** A short-lived link to the original recording, named after the meeting. */
    @GetMapping("/audio")
    public AudioDownloadResponse audio(@PathVariable String id) {
        return exports.audio(SecurityUtils.currentUserId(), id);
    }

    /**
     * The recording as an MP3 — the same link when it is already one, a
     * converted copy when it is not.
     *
     * <p>Its own path rather than {@code /audio?format=mp3} because it does not
     * behave like {@code /audio}. That endpoint always answers with a link; this
     * one may answer "not yet, ask again", and a caller that reads the two as
     * one shape will eventually follow a null URL. Keeping them separate also
     * keeps {@code /audio} exactly as it was for everything already using it.
     *
     * <p>A GET, and safe to repeat: it starts a conversion at most once for a
     * given recording, and every call after that is a HEAD and a signature.
     */
    @GetMapping("/audio/mp3")
    public AudioExportResponse audioAsMp3(@PathVariable String id) {
        return exports.audioAsMp3(SecurityUtils.currentUserId(), id);
    }
}
