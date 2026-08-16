package com.recallix.controller;

import com.recallix.common.ApiException;
import com.recallix.domain.ExportFormat;
import com.recallix.dto.AudioDownloadResponse;
import com.recallix.export.Downloads;
import com.recallix.export.ExportFile;
import com.recallix.security.SecurityUtils;
import com.recallix.service.ExportService;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Arrays;

/**
 * Taking a meeting out of Recallix.
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
     * @param format     pdf, docx, md or txt
     * @param transcript include the full transcript, which is usually most of the file
     * @param language   read it in a language the meeting has already been translated into
     * @param tz         the reader's IANA time zone, so the date matches the app's
     */
    @GetMapping("/export")
    public ResponseEntity<byte[]> export(@PathVariable String id,
                                         @RequestParam(defaultValue = "pdf") String format,
                                         @RequestParam(defaultValue = "false") boolean transcript,
                                         @RequestParam(required = false) String language,
                                         @RequestParam(required = false) String tz) {
        ExportFormat chosen = ExportFormat.find(format).orElseThrow(() -> ApiException.badRequest(
                "Unsupported export format. Recallix writes: "
                        + String.join(", ", Arrays.stream(ExportFormat.values())
                                .map(ExportFormat::extension).toList())));

        ExportFile file = exports.render(
                SecurityUtils.currentUserId(), id, chosen, transcript, language, tz);

        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, file.mediaType())
                .header(HttpHeaders.CONTENT_DISPOSITION, Downloads.attachment(file.filename()))
                // Rendered from live data — a summary corrected a minute ago has
                // to be in the next download, not in the one after it.
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .body(file.content());
    }

    /** A short-lived link to the original recording, named after the meeting. */
    @GetMapping("/audio")
    public AudioDownloadResponse audio(@PathVariable String id) {
        return exports.audio(SecurityUtils.currentUserId(), id);
    }
}
