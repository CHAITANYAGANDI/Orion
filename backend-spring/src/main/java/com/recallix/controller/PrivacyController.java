package com.recallix.controller;

import com.recallix.dto.AccountCloseRequest;
import com.recallix.dto.PrivacyOverviewResponse;
import com.recallix.dto.RetentionUpdateRequest;
import com.recallix.security.SecurityUtils;
import com.recallix.service.PrivacyService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * The three things somebody asks when they stop and think about what a
 * meeting recorder has of theirs.
 *
 * <p>What do you have — {@code GET /}. How long will you keep it —
 * {@code PATCH /retention}, and {@code DELETE /account} when the answer is
 * "not at all".
 *
 * <p>"Who else can see it" used to be the third, answered by a list of live
 * share links and {@code POST /links/revoke-all} to end them at once. Sharing is
 * gone, so the answer is nobody: nothing this account holds is reachable without
 * its own credentials, and there is no longer a question to ask.
 *
 * <p>There was a fourth, {@code GET /export}: the whole account as a zip, meant
 * to be downloaded before pressing the button underneath it. It is gone, and
 * with it the only bulk read in the API. A single meeting still exports in four
 * formats from the meeting itself.
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

    public PrivacyController(PrivacyService privacy) {
        this.privacy = privacy;
    }

    @GetMapping
    public PrivacyOverviewResponse overview() {
        return privacy.overview(SecurityUtils.currentUserId(), PrivacyService.todayUtc());
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
