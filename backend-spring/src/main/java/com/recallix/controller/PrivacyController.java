package com.recallix.controller;

import com.recallix.dto.AccountCloseRequest;
import com.recallix.dto.LiveLinkResponse;
import com.recallix.dto.PrivacyOverviewResponse;
import com.recallix.dto.RetentionUpdateRequest;
import com.recallix.export.Downloads;
import com.recallix.export.ExportFile;
import com.recallix.security.SecurityUtils;
import com.recallix.service.AccountExportService;
import com.recallix.service.PrivacyService;
import jakarta.validation.Valid;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * The four things somebody asks when they stop and think about what a
 * meeting recorder has of theirs.
 *
 * <p>What do you have — {@code GET /}. Who else can see it — the links in that
 * same response, and {@code POST /links/revoke-all} to end all of it at once.
 * How long will you keep it — {@code PATCH /retention}. And how do I leave —
 * {@code GET /export} then {@code DELETE /account}, in that order, which is why
 * they sit next to each other.
 *
 * <p>Everything here is scoped to the caller by the same tenant context as the
 * rest of the API. There is no administrator view, because there is no
 * administrator: one account per workspace means the person asking these
 * questions is the only person who can answer them.
 */
@RestController
@RequestMapping("/api/v1/privacy")
public class PrivacyController {

    private final PrivacyService privacy;
    private final AccountExportService accountExport;

    public PrivacyController(PrivacyService privacy, AccountExportService accountExport) {
        this.privacy = privacy;
        this.accountExport = accountExport;
    }

    @GetMapping
    public PrivacyOverviewResponse overview() {
        return privacy.overview(SecurityUtils.currentUserId(), PrivacyService.todayUtc());
    }

    /** Every link a stranger holding the URL could open right now. */
    @GetMapping("/links")
    public List<LiveLinkResponse> links() {
        return privacy.links(SecurityUtils.currentUserId());
    }

    @PostMapping("/links/revoke-all")
    public Map<String, Integer> revokeAll() {
        return Map.of("revoked", privacy.revokeAllLinks(SecurityUtils.currentUserId()));
    }

    /**
     * Set both retention windows.
     *
     * <p>Returns what the new policy would delete tonight, so the page can say
     * it immediately rather than leaving somebody to discover the size of their
     * decision in the morning.
     */
    @PatchMapping("/retention")
    public PrivacyOverviewResponse.Retention retention(@Valid @RequestBody RetentionUpdateRequest req) {
        return privacy.setRetention(SecurityUtils.currentUserId(),
                req.audioDays(), req.meetingDays(), PrivacyService.todayUtc());
    }

    /**
     * The whole account as a zip.
     *
     * @param tz the reader's IANA time zone, so dates in the readable copies
     *           match the ones they saw in the app
     */
    @GetMapping("/export")
    public ResponseEntity<byte[]> export(@RequestParam(required = false) String tz) {
        ExportFile file = accountExport.build(SecurityUtils.currentUserId(), tz);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, file.mediaType())
                .header(HttpHeaders.CONTENT_DISPOSITION, Downloads.attachment(file.filename()))
                // Never cached: this is the most sensitive response the API
                // produces, and the one most likely to be fetched from a shared
                // machine.
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .body(file.content());
    }

    /**
     * Close the account and delete everything in it. Immediate, irreversible.
     *
     * <p>200 rather than 204: the caller is told what was destroyed, which is
     * the last useful thing Recallix can do for them and the only receipt they
     * will get.
     */
    @DeleteMapping("/account")
    public PrivacyService.Closed close(@Valid @RequestBody AccountCloseRequest req) {
        return privacy.closeAccount(SecurityUtils.currentUserId(), req.confirm());
    }
}
