package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.domain.Plan;
import com.recallix.dto.UsageResponse;
import com.recallix.entity.UsageLimit;
import com.recallix.repository.UsageLimitRepository;
import com.recallix.repository.UserRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;

/**
 * Enforces per-plan monthly quotas (meetings + AI minutes). The DB
 * {@code usage_limits} row for the current calendar month is the source of
 * truth; {@link RateLimitService} adds a fast Redis short-circuit on hot paths.
 */
@Service
public class UsageLimitService {

    private final UsageLimitRepository usage;
    private final UserRepository users;

    public UsageLimitService(UsageLimitRepository usage, UserRepository users) {
        this.usage = usage;
        this.users = users;
    }

    private Plan planOf(String userId) {
        return users.findById(userId).map(u -> Plan.fromString(u.getPlan())).orElse(Plan.FREE);
    }

    @Transactional
    public UsageLimit currentPeriod(String userId) {
        Instant now = Instant.now();
        return usage.findCurrent(userId, now).orElseGet(() -> {
            LocalDate today = LocalDate.now(ZoneOffset.UTC);
            Instant start = today.withDayOfMonth(1).atStartOfDay(ZoneOffset.UTC).toInstant();
            Instant end = today.withDayOfMonth(1).plusMonths(1).atStartOfDay(ZoneOffset.UTC).toInstant();
            UsageLimit u = new UsageLimit();
            u.setId(IdGenerator.usage());
            u.setUserId(userId);
            u.setPeriodStart(start);
            u.setPeriodEnd(end);
            u.setMeetingsUsed(0);
            u.setAiMinutesUsed(0);
            return usage.save(u);
        });
    }

    @Transactional(readOnly = true)
    public UsageResponse getUsage(String userId) {
        Plan plan = planOf(userId);
        UsageLimit u = usage.findCurrent(userId, Instant.now()).orElse(null);
        if (u == null) {
            LocalDate today = LocalDate.now(ZoneOffset.UTC);
            Instant start = today.withDayOfMonth(1).atStartOfDay(ZoneOffset.UTC).toInstant();
            Instant end = today.withDayOfMonth(1).plusMonths(1).atStartOfDay(ZoneOffset.UTC).toInstant();
            return new UsageResponse(plan.name(), start, end, 0, plan.meetingsLimit(), 0, plan.aiMinutesLimit());
        }
        return new UsageResponse(plan.name(), u.getPeriodStart(), u.getPeriodEnd(),
                u.getMeetingsUsed(), plan.meetingsLimit(), u.getAiMinutesUsed(), plan.aiMinutesLimit());
    }

    /** Throws 429 if the meeting quota is exhausted; otherwise increments it. */
    @Transactional
    public void incrementMeetingsOrThrow(String userId) {
        Plan plan = planOf(userId);
        UsageLimit u = currentPeriod(userId);
        if (!plan.isUnlimited() && u.getMeetingsUsed() >= plan.meetingsLimit()) {
            throw ApiException.usageLimitReached(
                    "Monthly meeting limit reached for the " + plan.name() + " plan. Upgrade to continue.");
        }
        u.setMeetingsUsed(u.getMeetingsUsed() + 1);
    }

    @Transactional
    public void addAiMinutes(String userId, int minutes) {
        UsageLimit u = currentPeriod(userId);
        u.setAiMinutesUsed(u.getAiMinutesUsed() + Math.max(0, minutes));
    }
}
