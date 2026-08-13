package com.recallix.repository;

import com.recallix.entity.KnownSpeaker;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface KnownSpeakerRepository extends JpaRepository<KnownSpeaker, String> {

    /** Suggestion order: most used first, then most recently used. */
    List<KnownSpeaker> findByUserIdOrderByTimesUsedDescLastUsedAtDesc(String userId);

    Optional<KnownSpeaker> findByIdAndUserId(String id, String userId);

    @Query("""
            SELECT k FROM KnownSpeaker k
            WHERE k.userId = :userId AND lower(trim(k.displayName)) = lower(trim(:name))
            """)
    Optional<KnownSpeaker> findByUserIdAndNameIgnoreCase(@Param("userId") String userId,
                                                         @Param("name") String name);
}
