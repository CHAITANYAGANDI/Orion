package com.recallix.repository;

import com.recallix.entity.CalendarAccount;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface CalendarAccountRepository extends JpaRepository<CalendarAccount, String> {

    List<CalendarAccount> findByUserIdOrderByCreatedAtAsc(String userId);

    Optional<CalendarAccount> findByIdAndUserId(String id, String userId);

    /**
     * Backs "is this the same account reconnecting?" (unique constraint in V17).
     * Without it a second consent creates a duplicate row and the user's events
     * appear twice in the merged list.
     */
    Optional<CalendarAccount> findByUserIdAndProviderAndExternalAccountId(
            String userId, String provider, String externalAccountId);
}
