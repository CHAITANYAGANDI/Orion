package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.domain.VocabularyCategory;
import com.recallix.dto.VocabularyTermRequest;
import com.recallix.dto.VocabularyTermResponse;
import com.recallix.entity.VocabularyTerm;
import com.recallix.repository.VocabularyTermRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Comparator;
import java.util.List;

/**
 * Per-user transcription vocabulary: keywords, names, jargon and acronyms.
 *
 * <p>These are hints, not rules. They are sent to the transcriber as boosting
 * terms, which raises the probability of a word being recognised without
 * forcing it — so adding "Kubernetes" makes it more likely to be heard
 * correctly and does not rewrite "coordinates" into it.
 */
@Service
public class VocabularyService {

    /**
     * Deepgram accepts more than this, but recognition quality degrades as the
     * list grows: every extra term is another word the model is biased toward,
     * and a list of everything boosts nothing. The cap is per user and is
     * enforced on write so the failure is a clear message at the point of
     * adding, not a silently truncated list at transcription time.
     */
    public static final int MAX_TERMS_PER_USER = 500;

    private final VocabularyTermRepository terms;
    private final AuditService audit;

    public VocabularyService(VocabularyTermRepository terms, AuditService audit) {
        this.terms = terms;
        this.audit = audit;
    }

    @Transactional(readOnly = true)
    public List<VocabularyTermResponse> list(String userId) {
        return terms.findByUserIdOrderByCategoryAscTermAsc(userId).stream()
                .map(VocabularyTermResponse::from)
                .toList();
    }

    @Transactional
    public VocabularyTermResponse create(String userId, VocabularyTermRequest req) {
        String term = req.trimmedTerm();
        if (term.isBlank()) {
            throw ApiException.badRequest("A term cannot be empty");
        }
        terms.findByUserIdAndTermIgnoreCase(userId, term).ifPresent(existing -> {
            throw ApiException.badRequest("\"" + existing.getTerm() + "\" is already in your vocabulary");
        });
        if (terms.countByUserId(userId) >= MAX_TERMS_PER_USER) {
            throw ApiException.badRequest(
                    "You have reached the limit of " + MAX_TERMS_PER_USER
                            + " vocabulary terms; remove one before adding another");
        }

        VocabularyTerm entity = new VocabularyTerm();
        entity.setId(IdGenerator.vocabulary());
        entity.setUserId(userId);
        entity.setTerm(term);
        entity.setCategory(req.category());
        entity.setExpansion(req.expansionOrEmpty());
        entity.setActive(req.activeOrDefault());
        terms.save(entity);

        audit.record(userId, "VOCABULARY_TERM_ADDED", "vocabulary_term", entity.getId());
        return VocabularyTermResponse.from(entity);
    }

    @Transactional
    public VocabularyTermResponse update(String userId, String termId, VocabularyTermRequest req) {
        VocabularyTerm entity = terms.findByIdAndUserId(termId, userId)
                .orElseThrow(() -> ApiException.notFound("Vocabulary term not found"));

        String term = req.trimmedTerm();
        if (term.isBlank()) {
            throw ApiException.badRequest("A term cannot be empty");
        }
        // Renaming onto another row's term would violate the unique index; the
        // row being edited is allowed to keep its own term.
        terms.findByUserIdAndTermIgnoreCase(userId, term)
                .filter(other -> !other.getId().equals(termId))
                .ifPresent(other -> {
                    throw ApiException.badRequest(
                            "\"" + other.getTerm() + "\" is already in your vocabulary");
                });

        entity.setTerm(term);
        entity.setCategory(req.category());
        entity.setExpansion(req.expansionOrEmpty());
        entity.setActive(req.activeOrDefault());
        entity.setUpdatedAt(Instant.now());

        audit.record(userId, "VOCABULARY_TERM_UPDATED", "vocabulary_term", termId);
        return VocabularyTermResponse.from(entity);
    }

    @Transactional
    public void delete(String userId, String termId) {
        VocabularyTerm entity = terms.findByIdAndUserId(termId, userId)
                .orElseThrow(() -> ApiException.notFound("Vocabulary term not found"));
        terms.delete(entity);
        audit.record(userId, "VOCABULARY_TERM_DELETED", "vocabulary_term", termId);
    }

    /**
     * The boosting list sent with a transcription job.
     *
     * <p>Acronym expansions ride along as their own terms: "SRE" and "site
     * reliability engineering" are both things the speaker might have said, and
     * boosting only the letters helps with one of them.
     *
     * <p>Ordered longest-first because a multi-word phrase is the harder thing
     * to recognise and the one worth spending list positions on if a provider
     * ever truncates.
     */
    @Transactional(readOnly = true)
    public List<String> boostTermsFor(String userId) {
        return terms.findByUserIdAndActiveTrue(userId).stream()
                .flatMap(term -> term.getCategory() == VocabularyCategory.ACRONYM
                        && !term.getExpansion().isBlank()
                        ? java.util.stream.Stream.of(term.getTerm(), term.getExpansion())
                        : java.util.stream.Stream.of(term.getTerm()))
                .map(String::trim)
                .filter(term -> !term.isBlank())
                .distinct()
                .sorted(Comparator.comparingInt(String::length).reversed())
                .toList();
    }
}
