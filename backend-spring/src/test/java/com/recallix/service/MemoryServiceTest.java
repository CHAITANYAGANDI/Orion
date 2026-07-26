package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.entity.Commitment;
import com.recallix.entity.CommitmentEvidence;
import com.recallix.entity.DecisionLink;
import com.recallix.entity.MeetingActionItem;
import com.recallix.entity.MeetingDecision;
import com.recallix.repository.CommitmentEvidenceRepository;
import com.recallix.repository.CommitmentRepository;
import com.recallix.repository.DecisionLinkRepository;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingDecisionRepository;
import com.recallix.repository.MeetingRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Unit tests for the commitment ledger's decision-making.
 *
 * <p>These target the rules that are easy to get subtly wrong and invisible at
 * runtime: which verdicts move a status and which deliberately do not, that
 * reprocessing a meeting does not duplicate its history, and that a promise is
 * only ever retired after sustained silence.
 *
 * <p>Lenient strictness because the evidence lookup has both a per-id and a
 * batched form; stubbing both keeps these tests honest across that refactor —
 * they assert behaviour, not the query shape used to reach it.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class MemoryServiceTest {

    private static final String USER = "usr_1";
    private static final String MEETING = "mtg_later";
    private static final String ORIGIN = "mtg_origin";

    @Mock private CommitmentRepository commitments;
    @Mock private CommitmentEvidenceRepository evidence;
    @Mock private DecisionLinkRepository decisionLinks;
    @Mock private MeetingActionItemRepository actionItems;
    @Mock private MeetingDecisionRepository decisions;
    @Mock private MeetingRepository meetings;
    @Mock private AiClient ai;

    private MemoryService service;

    @BeforeEach
    void setUp() {
        service = new MemoryService(
                commitments, evidence, decisionLinks, actionItems, decisions, meetings, ai);
        // Default: nothing to promote, nothing indexed, no findings.
        when(actionItems.findByMeetingId(anyString())).thenReturn(List.of());
        when(commitments.findByActionItemIdIn(anyList())).thenReturn(List.of());
        when(decisions.findByMeetingId(anyString())).thenReturn(List.of());
        when(evidence.findByCommitmentIdOrderByCreatedAtAsc(anyString())).thenReturn(List.of());
        when(evidence.findByCommitmentIdInOrderByCreatedAtAsc(anyList())).thenReturn(List.of());
        when(evidence.findByCommitmentIdAndMeetingId(anyString(), anyString()))
                .thenReturn(Optional.empty());
        when(meetings.findAllById(any())).thenReturn(List.of());
    }

    // --- promotion ---------------------------------------------------------- //

    @Test
    @DisplayName("action items become commitments when their meeting completes")
    void promotesActionItems() {
        when(actionItems.findByMeetingId(MEETING)).thenReturn(List.of(
                actionItem("ai_1", "Finish JWT validation", "Chaitanya", "Friday")));
        when(commitments.findReconcilable(USER, MEETING)).thenReturn(List.of());

        service.reconcileMeeting(MEETING, USER);

        ArgumentCaptor<Commitment> saved = ArgumentCaptor.forClass(Commitment.class);
        verify(commitments).save(saved.capture());
        Commitment c = saved.getValue();
        assertThat(c.getText()).isEqualTo("Finish JWT validation");
        assertThat(c.getOwnerName()).isEqualTo("Chaitanya");
        assertThat(c.getDueDate()).isEqualTo("Friday");
        assertThat(c.getStatus()).isEqualTo(Commitment.OPEN);
        assertThat(c.getUserId()).isEqualTo(USER);
        assertThat(c.getOriginMeetingId()).isEqualTo(MEETING);
    }

    @Test
    @DisplayName("reprocessing a meeting does not promote the same action item twice")
    void promotionIsIdempotent() {
        MeetingActionItem item = actionItem("ai_1", "Finish JWT validation", "Chaitanya", null);
        when(actionItems.findByMeetingId(MEETING)).thenReturn(List.of(item));
        Commitment existing = commitment("cmt_1", "Finish JWT validation", Commitment.OPEN, 0);
        existing.setActionItemId("ai_1");
        when(commitments.findByActionItemIdIn(anyList())).thenReturn(List.of(existing));
        when(commitments.findReconcilable(USER, MEETING)).thenReturn(List.of());

        service.reconcileMeeting(MEETING, USER);

        verify(commitments, never()).save(any());
    }

    // --- verdicts moving status --------------------------------------------- //

    @Test
    @DisplayName("FULFILLED closes the commitment")
    void fulfilledVerdictClosesCommitment() {
        Commitment c = reconcileWithVerdict("FULFILLED");
        assertThat(c.getStatus()).isEqualTo(Commitment.FULFILLED);
    }

    @Test
    @DisplayName("SLIPPED marks the commitment late")
    void slippedVerdictMarksLate() {
        Commitment c = reconcileWithVerdict("SLIPPED");
        assertThat(c.getStatus()).isEqualTo(Commitment.SLIPPED);
    }

    @Test
    @DisplayName("CANCELLED retires the commitment")
    void cancelledVerdictRetiresCommitment() {
        Commitment c = reconcileWithVerdict("CANCELLED");
        assertThat(c.getStatus()).isEqualTo(Commitment.CANCELLED);
    }

    @Test
    @DisplayName("RESTATED records evidence but deliberately leaves the status alone")
    void restatedVerdictDoesNotResolve() {
        Commitment c = reconcileWithVerdict("RESTATED");
        // The promise was raised again without being resolved — reporting it as
        // fulfilled or slipped would both be wrong.
        assertThat(c.getStatus()).isEqualTo(Commitment.OPEN);
        verify(evidence).save(any(CommitmentEvidence.class));
    }

    @Test
    @DisplayName("evidence carries the quote and timestamp that justify the verdict")
    void evidenceIsAuditable() {
        reconcileWithVerdict("FULFILLED");

        ArgumentCaptor<CommitmentEvidence> saved = ArgumentCaptor.forClass(CommitmentEvidence.class);
        verify(evidence).save(saved.capture());
        CommitmentEvidence e = saved.getValue();
        assertThat(e.getVerdict()).isEqualTo("FULFILLED");
        assertThat(e.getQuote()).isEqualTo("it is done and merged");
        assertThat(e.getStartTime()).isEqualTo(12.5);
        assertThat(e.getMeetingId()).isEqualTo(MEETING);
    }

    @Test
    @DisplayName("re-reconciling a meeting overwrites its evidence rather than duplicating it")
    void evidenceIsIdempotentPerMeeting() {
        CommitmentEvidence existing = new CommitmentEvidence();
        existing.setId("evd_existing");
        existing.setCommitmentId("cmt_1");
        existing.setMeetingId(MEETING);
        existing.setVerdict("RESTATED");
        when(evidence.findByCommitmentIdAndMeetingId("cmt_1", MEETING))
                .thenReturn(Optional.of(existing));

        reconcileWithVerdict("FULFILLED");

        ArgumentCaptor<CommitmentEvidence> saved = ArgumentCaptor.forClass(CommitmentEvidence.class);
        verify(evidence).save(saved.capture());
        // Same row, updated verdict — not a second row.
        assertThat(saved.getValue().getId()).isEqualTo("evd_existing");
        assertThat(saved.getValue().getVerdict()).isEqualTo("FULFILLED");
    }

    @Test
    @DisplayName("a verdict for an unknown commitment is ignored")
    void unknownCommitmentVerdictIsIgnored() {
        Commitment c = commitment("cmt_1", "Finish JWT validation", Commitment.OPEN, 0);
        when(commitments.findReconcilable(USER, MEETING)).thenReturn(List.of(c));
        when(ai.reconcile(anyString(), anyString(), anyList(), anyList()))
                .thenReturn(new AiClient.ReconcileResult(
                        List.of(new AiClient.CommitmentVerdict(
                                "cmt_does_not_exist", "FULFILLED", "r", "q", 1.0, "high")),
                        List.of()));

        service.reconcileMeeting(MEETING, USER);

        assertThat(c.getStatus()).isEqualTo(Commitment.OPEN);
        verify(evidence, never()).save(any());
    }

    // --- silence and dropping ------------------------------------------------ //

    @Test
    @DisplayName("every reconciled meeting counts as a check against open commitments")
    void checksAreCounted() {
        Commitment c = commitment("cmt_1", "Write the migration guide", Commitment.OPEN, 0);
        when(commitments.findReconcilable(USER, MEETING)).thenReturn(List.of(c));
        when(ai.reconcile(anyString(), anyString(), anyList(), anyList()))
                .thenReturn(AiClient.ReconcileResult.empty());

        service.reconcileMeeting(MEETING, USER);

        assertThat(c.getChecksRun()).isEqualTo(1);
        assertThat(c.getLastCheckedAt()).isNotNull();
        assertThat(c.getStatus()).isEqualTo(Commitment.OPEN);
    }

    @Test
    @DisplayName("a promise unmentioned across three meetings is treated as dropped")
    void silenceEventuallyDropsTheCommitment() {
        Commitment c = commitment("cmt_1", "Write the migration guide", Commitment.OPEN, 2);
        when(commitments.findReconcilable(USER, MEETING)).thenReturn(List.of(c));
        when(ai.reconcile(anyString(), anyString(), anyList(), anyList()))
                .thenReturn(AiClient.ReconcileResult.empty());

        service.reconcileMeeting(MEETING, USER);

        assertThat(c.getChecksRun()).isEqualTo(3);
        assertThat(c.getStatus()).isEqualTo(Commitment.DROPPED);
    }

    @Test
    @DisplayName("a commitment with any evidence is never dropped for silence")
    void evidencePreventsDropping() {
        Commitment c = commitment("cmt_1", "Write the migration guide", Commitment.OPEN, 5);
        when(commitments.findReconcilable(USER, MEETING)).thenReturn(List.of(c));
        CommitmentEvidence prior = new CommitmentEvidence();
        prior.setCommitmentId("cmt_1");
        prior.setVerdict("RESTATED");
        when(evidence.findByCommitmentIdOrderByCreatedAtAsc("cmt_1")).thenReturn(List.of(prior));
        when(evidence.findByCommitmentIdInOrderByCreatedAtAsc(anyList())).thenReturn(List.of(prior));
        when(ai.reconcile(anyString(), anyString(), anyList(), anyList()))
                .thenReturn(AiClient.ReconcileResult.empty());

        service.reconcileMeeting(MEETING, USER);

        assertThat(c.getStatus()).isEqualTo(Commitment.OPEN);
    }

    // --- decision drift ------------------------------------------------------ //

    @Test
    @DisplayName("a decision link is stored once and updated on re-reconcile")
    void decisionLinkIsIdempotent() {
        when(commitments.findReconcilable(USER, MEETING)).thenReturn(List.of());
        when(decisions.findByMeetingId(MEETING)).thenReturn(List.of(decision("dec_2", "Use Deepgram")));
        when(ai.reconcile(anyString(), anyString(), anyList(), anyList()))
                .thenReturn(new AiClient.ReconcileResult(List.of(), List.of(
                        new AiClient.DecisionLinkResult("dec_1", "dec_2", "CONTRADICTS", "why", 0.8))));
        when(decisionLinks.findByEarlierDecisionIdAndLaterDecisionId("dec_1", "dec_2"))
                .thenReturn(Optional.empty());

        service.reconcileMeeting(MEETING, USER);

        ArgumentCaptor<DecisionLink> saved = ArgumentCaptor.forClass(DecisionLink.class);
        verify(decisionLinks).save(saved.capture());
        assertThat(saved.getValue().getRelation()).isEqualTo("CONTRADICTS");
        assertThat(saved.getValue().getSimilarity()).isEqualTo(0.8);
        assertThat(saved.getValue().isAcknowledged()).isFalse();
    }

    @Test
    @DisplayName("a decision is never linked to itself")
    void selfLinksAreRejected() {
        when(commitments.findReconcilable(USER, MEETING)).thenReturn(List.of());
        when(decisions.findByMeetingId(MEETING)).thenReturn(List.of(decision("dec_1", "Use Deepgram")));
        when(ai.reconcile(anyString(), anyString(), anyList(), anyList()))
                .thenReturn(new AiClient.ReconcileResult(List.of(), List.of(
                        new AiClient.DecisionLinkResult("dec_1", "dec_1", "REAFFIRMS", "why", 1.0))));

        service.reconcileMeeting(MEETING, USER);

        verify(decisionLinks, never()).save(any());
    }

    // --- resilience ---------------------------------------------------------- //

    @Test
    @DisplayName("an ai-service failure leaves the meeting untouched instead of propagating")
    void aiFailureIsSwallowed() {
        Commitment c = commitment("cmt_1", "Finish JWT validation", Commitment.OPEN, 0);
        when(commitments.findReconcilable(USER, MEETING)).thenReturn(List.of(c));
        when(ai.reconcile(anyString(), anyString(), anyList(), anyList()))
                .thenThrow(new RuntimeException("ai-service unreachable"));

        // Memory is advisory: the meeting is already persisted and READY.
        service.reconcileMeeting(MEETING, USER);

        assertThat(c.getStatus()).isEqualTo(Commitment.OPEN);
        assertThat(c.getChecksRun()).isZero();
    }

    @Test
    @DisplayName("nothing to reconcile means the ai-service is never called")
    void emptyMeetingSkipsTheAiCall() {
        when(commitments.findReconcilable(USER, MEETING)).thenReturn(List.of());
        when(decisions.findByMeetingId(MEETING)).thenReturn(List.of());

        service.reconcileMeeting(MEETING, USER);

        verify(ai, never()).reconcile(anyString(), anyString(), anyList(), anyList());
    }

    // --- manual override ------------------------------------------------------ //

    @Test
    @DisplayName("a user can override an inferred status")
    void userCanOverrideStatus() {
        Commitment c = commitment("cmt_1", "Finish JWT validation", Commitment.DROPPED, 4);
        when(commitments.findByIdAndUserId("cmt_1", USER)).thenReturn(Optional.of(c));

        service.updateStatus(USER, "cmt_1", "fulfilled");

        assertThat(c.getStatus()).isEqualTo(Commitment.FULFILLED);
    }

    @Test
    @DisplayName("an unknown status is rejected")
    void unknownStatusIsRejected() {
        Commitment c = commitment("cmt_1", "Finish JWT validation", Commitment.OPEN, 0);
        when(commitments.findByIdAndUserId("cmt_1", USER)).thenReturn(Optional.of(c));

        assertThatThrownBy(() -> service.updateStatus(USER, "cmt_1", "MAYBE"))
                .isInstanceOf(ApiException.class);
        assertThat(c.getStatus()).isEqualTo(Commitment.OPEN);
    }

    @Test
    @DisplayName("another user's commitment is not found")
    void commitmentIsScopedToItsOwner() {
        when(commitments.findByIdAndUserId("cmt_1", "usr_other")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.updateStatus("usr_other", "cmt_1", "FULFILLED"))
                .isInstanceOf(ApiException.class);
    }

    @Test
    @DisplayName("drift findings whose decisions were deleted are skipped, not returned broken")
    void driftSkipsDeletedDecisions() {
        DecisionLink link = new DecisionLink();
        link.setId("dlk_1");
        link.setUserId(USER);
        link.setEarlierDecisionId("dec_gone");
        link.setLaterDecisionId("dec_2");
        link.setRelation("CONTRADICTS");
        when(decisionLinks.findByUserIdAndAcknowledgedOrderByCreatedAtDesc(USER, false))
                .thenReturn(List.of(link));
        // Only the later decision still exists.
        when(decisions.findAllById(any())).thenReturn(List.of(decision("dec_2", "Use Deepgram")));

        assertThat(service.drift(USER, false)).isEmpty();
    }

    // --- helpers -------------------------------------------------------------- //

    /** Runs a reconcile where the ai-service returns exactly one verdict. */
    private Commitment reconcileWithVerdict(String outcome) {
        Commitment c = commitment("cmt_1", "Finish JWT validation", Commitment.OPEN, 0);
        when(commitments.findReconcilable(USER, MEETING)).thenReturn(List.of(c));
        when(ai.reconcile(anyString(), anyString(), anyList(), anyList()))
                .thenReturn(new AiClient.ReconcileResult(
                        List.of(new AiClient.CommitmentVerdict(
                                "cmt_1", outcome, "because", "it is done and merged", 12.5, "high")),
                        List.of()));

        service.reconcileMeeting(MEETING, USER);
        return c;
    }

    private static Commitment commitment(String id, String text, String status, int checksRun) {
        Commitment c = new Commitment();
        c.setId(id);
        c.setUserId(USER);
        c.setOriginMeetingId(ORIGIN);
        c.setText(text);
        c.setStatus(status);
        c.setChecksRun(checksRun);
        return c;
    }

    private static MeetingActionItem actionItem(String id, String title, String owner, String due) {
        MeetingActionItem a = new MeetingActionItem();
        a.setId(id);
        a.setMeetingId(MEETING);
        a.setTitle(title);
        a.setOwnerName(owner);
        a.setDueDate(due);
        return a;
    }

    private static MeetingDecision decision(String id, String text) {
        MeetingDecision d = new MeetingDecision();
        d.setId(id);
        d.setMeetingId(MEETING);
        d.setDecisionText(text);
        return d;
    }
}
