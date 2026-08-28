package com.orion.service;

import com.orion.security.TenantContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.ZoneOffset;

/**
 * Fires the nightly retention pass.
 *
 * <p>Separate from the service it calls: the scheduler thread has no
 * authenticated user, so the work needs {@link TenantContext#runAsSystem}, and
 * a bean that both schedules itself and establishes its own tenant is one whose
 * transaction boundary is easy to get quietly wrong. It also means a test can
 * apply a policy without a clock.
 *
 * <p>Three in the morning UTC. It is now the only scheduled pass over every
 * account — the eight o'clock digest it was timed away from went with the mail
 * in V56 — so the hour is free to be simply a quiet one.
 *
 * <p>{@code orion.retention.enabled=false} switches it off entirely, which is
 * what a restored-from-backup environment wants before anybody has looked at it:
 * a copy of production waking up and re-running last month's deletions against
 * data somebody is trying to recover is the failure mode worth a flag.
 */
@Component
public class RetentionJob {

    private static final Logger log = LoggerFactory.getLogger(RetentionJob.class);

    private final RetentionService retention;
    private final boolean enabled;

    public RetentionJob(RetentionService retention,
                        @Value("${orion.retention.enabled:true}") boolean enabled) {
        this.retention = retention;
        this.enabled = enabled;
    }

    @Scheduled(cron = "${orion.retention.cron:0 0 3 * * *}", zone = "UTC")
    public void applyRetention() {
        if (!enabled) {
            return;
        }
        try {
            int touched = TenantContext.asSystem(
                    () -> retention.applyAll(LocalDate.now(ZoneOffset.UTC)));
            if (touched > 0) {
                log.info("Retention pass finished: {} account(s) affected.", touched);
            }
        } catch (Exception e) {
            // Never let this kill the scheduler thread — the outbox relay and the
            // reminder digest run on it too.
            log.error("Retention pass failed: {}", e.getMessage(), e);
        }
    }
}
