package com.reverie.repository;

import com.reverie.entity.UsageLimit;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface UsageLimitRepository extends JpaRepository<UsageLimit, String> {

    /**
     * The account's counter, or nothing if it has never used anything.
     *
     * <p>By user rather than by user and period: the allowance is a lifetime one
     * (V47), so there is one row and it is unique on {@code user_id}.
     */
    Optional<UsageLimit> findByUserId(String userId);
}
