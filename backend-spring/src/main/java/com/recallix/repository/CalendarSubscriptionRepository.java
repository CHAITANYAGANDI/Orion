package com.recallix.repository;

import com.recallix.entity.CalendarSubscription;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface CalendarSubscriptionRepository extends JpaRepository<CalendarSubscription, String> {

    List<CalendarSubscription> findByUserIdOrderByCreatedAtAsc(String userId);

    Optional<CalendarSubscription> findByIdAndUserId(String id, String userId);

    /** Backs the "already subscribed" check (unique index in V8). */
    Optional<CalendarSubscription> findByUserIdAndUrl(String userId, String url);
}
