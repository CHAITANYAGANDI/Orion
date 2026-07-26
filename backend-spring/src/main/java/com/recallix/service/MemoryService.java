package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.dto.CommitmentEvidenceDto;
import com.recallix.dto.CommitmentResponse;
import com.recallix.dto.DecisionDriftResponse;
import com.recallix.dto.MemoryStatsResponse;
import com.recallix.dto.PageResponse;
import com.recallix.entity.Commitment;
import com.recallix.entity.CommitmentEvidence;
import com.recallix.entity.DecisionLink;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.entity.MeetingDecision;
import com.recallix.repository.CommitmentEvidenceRepository;
import com.recallix.repository.CommitmentRepository;
import com.recallix.repository.DecisionLinkRepository;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingDecisionRepository;
import com.recallix.repository.MeetingRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Meeting Memory: the commitment ledger and decision-drift index.
 *
 * <p>Every finished meeting does two things to memory. It <em>adds</em> — its
 * action items become commitments, its decisions become drift candidates — and
 * it <em>judges</em>: the meeting is evidence about every promise still open
 * from earlier meetings. The semantic work happens in the ai-service; this
 * service owns the ledger and decides what a verdict means.
 *
 * <p>Reconciliation is idempotent. Reprocessing a meeting overwrites that
 * meeting's evidence rather than appending a duplicate, so a commitment's status
 * always reflects the current transcript.
 */
@Service
public class MemoryService {

    private static final Logger log = LoggerFactory.getLogger(MemoryService.class);

    /**
     * How many later meetings may pass in silence before an open commitment is
     * treated as silently dropped rather than merely pending.
     */
    private static final int DROP_AFTER_SILENT_CHECKS = 3;

    private final CommitmentRepository commitments;
    private final CommitmentEvidenceRepository evidence;
    private final DecisionLinkRepository decisionLinks;
    private final MeetingActionItemRepository actionItems;
    private final MeetingDecisionRepository decisions;
    private final MeetingRepository meetings;
    private final AiClient ai;

    public MemoryService(CommitmentRepository commitments,
                         CommitmentEvidenceRepository evidence,
                         DecisionLinkRepository decisionLinks,
                         MeetingActionItemRepository actionItems,
                         MeetingDecisionRepository decisions,
                         MeetingRepository meetings,
                         AiClient ai) {
        this.commitments = commitments;
        this.evidence = evidence;
        this.decisionLinks = decisionLinks;
        this.actionItems = actionItems;
        this.decisions = decisions;
        this.meetings = meetings;
        this.ai = ai;
    }

    // --- reconciliation ----------------------------------------------------- //

    /**
     * Fold a newly-ready meeting into the user's memory. Called off the request
     * thread after the brief has been persisted and indexed.
     */
    @Transactional
    public void reconcileMeeting(String meetingId, String userId) {
        int promoted = promoteActionItems(meetingId, userId);

        List<Commitment> open = commitments.findReconcilable(userId, meetingId);
        List<MeetingDecision> meetingDecisions = decisions.findByMeetingId(meetingId);
        if (open.isEmpty() && meetingDecisions.isEmpty()) {
            log.debug("Nothing to reconcile for meeting {} ({} promoted).", meetingId, promoted);
            return;
        }

        List<AiClient.CommitmentProbe> probes = open.stream()
                .map(c -> new AiClient.CommitmentProbe(
                        c.getId(), c.getText(), c.getOwnerName(), c.getDueDate()))
                .toList();
        List<AiClient.DecisionProbe> decisionProbes = meetingDecisions.stream()
                .map(d -> new AiClient.DecisionProbe(d.getId(), d.getDecisionText()))
                .toList();

        AiClient.ReconcileResult result;
        try {
            result = ai.reconcile(userId, meetingId, probes, decisionProbes);
        } catch (Exception e) {
            // Memory is advisory — a reconciliation failure must not affect the
            // meeting itself, which is already persisted and READY.
            log.warn("Memory reconciliation failed for meeting {}: {}", meetingId, e.toString());
            return;
        }

        int applied = applyVerdicts(meetingId, open, result.commitmentVerdicts());
        int linked = applyDecisionLinks(userId, result.decisionLinks());
        markChecked(open, meetingId);

        log.info("Memory reconciled for meeting {}: {} promoted, {} verdicts, {} decision links.",
                meetingId, promoted, applied, linked);
    }

    /**
     * Promote this meeting's action items into the ledger. Skips items already
     * promoted so reprocessing does not duplicate the promise.
     */
    private int promoteActionItems(String meetingId, String userId) {
        List<MeetingActionItem> items = actionItems.findByMeetingId(meetingId);
        if (items.isEmpty()) {
            return 0;
        }
        List<String> ids = items.stream().map(MeetingActionItem::getId).toList();
        Set<String> alreadyPromoted = commitments.findByActionItemIdIn(ids).stream()
                .map(Commitment::getActionItemId)
                .collect(Collectors.toCollection(HashSet::new));

        int created = 0;
        for (MeetingActionItem item : items) {
            if (alreadyPromoted.contains(item.getId())) {
                continue;
            }
            Commitment c = new Commitment();
            c.setId(IdGenerator.generate("cmt_"));
            c.setUserId(userId);
            c.setActionItemId(item.getId());
            c.setOriginMeetingId(meetingId);
            c.setText(item.getTitle());
            c.setOwnerName(item.getOwnerName());
            c.setDueDate(item.getDueDate());
            c.setStatus(Commitment.OPEN);
            commitments.save(c);
            created++;
        }
        return created;
    }

    /** Record evidence and move commitment statuses accordingly. */
    private int applyVerdicts(String meetingId,
                              List<Commitment> open,
                              List<AiClient.CommitmentVerdict> verdicts) {
        if (verdicts.isEmpty()) {
            return 0;
        }
        Map<String, Commitment> byId = open.stream()
                .collect(Collectors.toMap(Commitment::getId, Function.identity(), (a, b) -> a));

        int applied = 0;
        for (AiClient.CommitmentVerdict v : verdicts) {
            Commitment c = byId.get(v.commitmentId());
            if (c == null || v.outcome() == null || v.outcome().isBlank()) {
                continue;
            }

            // One verdict per (commitment, meeting): update in place on reprocess.
            CommitmentEvidence e = evidence
                    .findByCommitmentIdAndMeetingId(c.getId(), meetingId)
                    .orElseGet(() -> {
                        CommitmentEvidence fresh = new CommitmentEvidence();
                        fresh.setId(IdGenerator.generate("evd_"));
                        fresh.setCommitmentId(c.getId());
                        fresh.setMeetingId(meetingId);
                        return fresh;
                    });
            e.setVerdict(v.outcome());
            e.setRationale(v.rationale());
            e.setQuote(v.quote());
            e.setStartTime(v.start());
            e.setConfidence(v.confidence());
            evidence.save(e);

            String next = statusFor(v.outcome());
            if (next != null) {
                c.setStatus(next);
            }
            applied++;
        }
        return applied;
    }

    /**
     * A RESTATED verdict deliberately returns null: the promise came up again
     * without resolution, which is evidence worth showing but not a status change.
     */
    private static String statusFor(String outcome) {
        return switch (outcome) {
            case CommitmentEvidence.FULFILLED -> Commitment.FULFILLED;
            case CommitmentEvidence.SLIPPED -> Commitment.SLIPPED;
            case CommitmentEvidence.CANCELLED -> Commitment.CANCELLED;
            default -> null;
        };
    }

    private int applyDecisionLinks(String userId, List<AiClient.DecisionLinkResult> links) {
        int created = 0;
        for (AiClient.DecisionLinkResult l : links) {
            if (l.earlierDecisionId() == null || l.laterDecisionId() == null
                    || l.earlierDecisionId().equals(l.laterDecisionId())) {
                continue;
            }
            Optional<DecisionLink> existing = decisionLinks
                    .findByEarlierDecisionIdAndLaterDecisionId(l.earlierDecisionId(), l.laterDecisionId());
            DecisionLink link = existing.orElseGet(() -> {
                DecisionLink fresh = new DecisionLink();
                fresh.setId(IdGenerator.generate("dlk_"));
                fresh.setUserId(userId);
                fresh.setEarlierDecisionId(l.earlierDecisionId());
                fresh.setLaterDecisionId(l.laterDecisionId());
                return fresh;
            });
            link.setRelation(l.relation());
            link.setRationale(l.rationale());
            link.setSimilarity(l.similarity());
            decisionLinks.save(link);
            created++;
        }
        return created;
    }

    /**
     * Count this meeting as a check against every open commitment, and retire
     * the ones that have now gone unmentioned across several meetings.
     */
    private void markChecked(List<Commitment> open, String meetingId) {
        Instant now = Instant.now();
        for (Commitment c : open) {
            c.setChecksRun(c.getChecksRun() + 1);
            c.setLastCheckedAt(now);
            boolean silent = evidence.findByCommitmentIdOrderByCreatedAtAsc(c.getId()).isEmpty();
            if (Commitment.OPEN.equals(c.getStatus())
                    && silent
                    && c.getChecksRun() >= DROP_AFTER_SILENT_CHECKS) {
                c.setStatus(Commitment.DROPPED);
            }
        }
    }

    // --- queries ------------------------------------------------------------ //

    @Transactional(readOnly = true)
    public PageResponse<CommitmentResponse> list(String userId, int page, int size, String status) {
        Page<Commitment> result = commitments.findForUser(
                userId, blankToNull(status), PageRequest.of(page, size));
        List<Commitment> content = result.getContent();

        Map<String, String> titles = meetingTitles(
                content.stream().map(Commitment::getOriginMeetingId).collect(Collectors.toSet()));
        Map<String, List<CommitmentEvidence>> evidenceByCommitment = evidenceFor(content);

        List<CommitmentResponse> mapped = content.stream()
                .map(c -> CommitmentResponse.from(
                        c,
                        titles.get(c.getOriginMeetingId()),
                        toEvidenceDtos(evidenceByCommitment.getOrDefault(c.getId(), List.of()))))
                .toList();
        return PageResponse.from(result, mapped);
    }

    @Transactional(readOnly = true)
    public CommitmentResponse get(String userId, String id) {
        Commitment c = commitments.findByIdAndUserId(id, userId)
                .orElseThrow(() -> ApiException.notFound("Commitment not found"));
        String title = meetings.findById(c.getOriginMeetingId()).map(Meeting::getTitle).orElse(null);
        return CommitmentResponse.from(
                c, title, toEvidenceDtos(evidence.findByCommitmentIdOrderByCreatedAtAsc(id)));
    }

    /** Manual override — the user always outranks an inferred status. */
    @Transactional
    public CommitmentResponse updateStatus(String userId, String id, String status) {
        Commitment c = commitments.findByIdAndUserId(id, userId)
                .orElseThrow(() -> ApiException.notFound("Commitment not found"));
        String next = status == null ? "" : status.toUpperCase();
        if (!Set.of(Commitment.OPEN, Commitment.FULFILLED, Commitment.SLIPPED,
                Commitment.CANCELLED, Commitment.DROPPED).contains(next)) {
            throw ApiException.badRequest("Unknown commitment status: " + status);
        }
        c.setStatus(next);
        String title = meetings.findById(c.getOriginMeetingId()).map(Meeting::getTitle).orElse(null);
        return CommitmentResponse.from(
                c, title, toEvidenceDtos(evidence.findByCommitmentIdOrderByCreatedAtAsc(id)));
    }

    @Transactional(readOnly = true)
    public List<DecisionDriftResponse> drift(String userId, boolean includeAcknowledged) {
        List<DecisionLink> links = includeAcknowledged
                ? decisionLinks.findByUserIdOrderByCreatedAtDesc(userId)
                : decisionLinks.findByUserIdAndAcknowledgedOrderByCreatedAtDesc(userId, false);
        if (links.isEmpty()) {
            return List.of();
        }

        Set<String> decisionIds = new HashSet<>();
        links.forEach(l -> {
            decisionIds.add(l.getEarlierDecisionId());
            decisionIds.add(l.getLaterDecisionId());
        });
        Map<String, MeetingDecision> byId = decisions.findAllById(decisionIds).stream()
                .collect(Collectors.toMap(MeetingDecision::getId, Function.identity(), (a, b) -> a));
        Map<String, String> titles = meetingTitles(byId.values().stream()
                .map(MeetingDecision::getMeetingId)
                .collect(Collectors.toSet()));

        List<DecisionDriftResponse> out = new ArrayList<>();
        for (DecisionLink l : links) {
            MeetingDecision earlier = byId.get(l.getEarlierDecisionId());
            MeetingDecision later = byId.get(l.getLaterDecisionId());
            // Either decision may have been deleted with its meeting.
            if (earlier == null || later == null) {
                continue;
            }
            out.add(DecisionDriftResponse.from(l, earlier, later,
                    titles.get(earlier.getMeetingId()), titles.get(later.getMeetingId())));
        }
        return out;
    }

    @Transactional
    public void acknowledgeDrift(String userId, String id) {
        DecisionLink link = decisionLinks.findByIdAndUserId(id, userId)
                .orElseThrow(() -> ApiException.notFound("Decision link not found"));
        link.setAcknowledged(true);
    }

    @Transactional(readOnly = true)
    public MemoryStatsResponse stats(String userId) {
        return new MemoryStatsResponse(
                commitments.countByUserIdAndStatus(userId, Commitment.OPEN),
                commitments.countByUserIdAndStatus(userId, Commitment.FULFILLED),
                commitments.countByUserIdAndStatus(userId, Commitment.SLIPPED),
                commitments.countByUserIdAndStatus(userId, Commitment.DROPPED),
                decisionLinks.countByUserIdAndAcknowledgedAndRelation(
                        userId, false, DecisionLink.CONTRADICTS));
    }

    // --- helpers ------------------------------------------------------------ //

    private Map<String, List<CommitmentEvidence>> evidenceFor(List<Commitment> list) {
        if (list.isEmpty()) {
            return Map.of();
        }
        List<String> ids = list.stream().map(Commitment::getId).toList();
        Map<String, List<CommitmentEvidence>> grouped = new HashMap<>();
        for (CommitmentEvidence e : evidence.findByCommitmentIdInOrderByCreatedAtAsc(ids)) {
            grouped.computeIfAbsent(e.getCommitmentId(), k -> new ArrayList<>()).add(e);
        }
        return grouped;
    }

    private List<CommitmentEvidenceDto> toEvidenceDtos(List<CommitmentEvidence> list) {
        if (list.isEmpty()) {
            return List.of();
        }
        Map<String, String> titles = meetingTitles(
                list.stream().map(CommitmentEvidence::getMeetingId).collect(Collectors.toSet()));
        return list.stream()
                .map(e -> CommitmentEvidenceDto.from(e, titles.get(e.getMeetingId())))
                .toList();
    }

    private Map<String, String> meetingTitles(Set<String> ids) {
        if (ids.isEmpty()) {
            return Map.of();
        }
        return meetings.findAllById(ids).stream()
                .collect(Collectors.toMap(Meeting::getId, Meeting::getTitle, (a, b) -> a));
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s;
    }
}
