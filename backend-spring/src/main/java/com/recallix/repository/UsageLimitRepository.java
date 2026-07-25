package com.recallix.repository;

import com.recallix.entity.UsageLimit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.Optional;

public interface UsageLimitRepository extends JpaRepository<UsageLimit, String> {

    @Query("""
            SELECT u FROM UsageLimit u
            WHERE u.userId = :userId AND u.periodStart <= :now AND u.periodEnd > :now
            """)
    Optional<UsageLimit> findCurrent(@Param("userId") String userId, @Param("now") Instant now);
}
