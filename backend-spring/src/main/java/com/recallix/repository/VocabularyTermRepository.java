package com.recallix.repository;

import com.recallix.entity.VocabularyTerm;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface VocabularyTermRepository extends JpaRepository<VocabularyTerm, String> {

    List<VocabularyTerm> findByUserIdOrderByCategoryAscTermAsc(String userId);

    Optional<VocabularyTerm> findByIdAndUserId(String id, String userId);

    /** The read that runs on every upload: what actually gets sent to the transcriber. */
    List<VocabularyTerm> findByUserIdAndActiveTrue(String userId);

    /**
     * Case-insensitive duplicate check, matching the unique index in V20.
     * Without it a duplicate surfaces as a constraint violation rather than a
     * message telling the user they already have the term.
     */
    @Query("""
            SELECT v FROM VocabularyTerm v
            WHERE v.userId = :userId AND lower(trim(v.term)) = lower(trim(:term))
            """)
    Optional<VocabularyTerm> findByUserIdAndTermIgnoreCase(@Param("userId") String userId,
                                                           @Param("term") String term);

    long countByUserId(String userId);
}
