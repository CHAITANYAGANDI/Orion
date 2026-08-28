package com.orion;

import com.orion.repository.OutboxEventRepository;
import com.orion.service.OutboxPublisher;
import com.orion.service.OutboxPurge;
import com.orion.service.OutboxRelay;
import com.orion.service.RetiredMeetingJobReconciler;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Start the whole thing once and see whether it comes up.
 *
 * <p>The companion to {@code ApplicationWiringTest}, which asks whether Spring
 * can pick a constructor. This asks the rest: do the beans those constructors
 * want actually exist, does the configuration bind, do the repository interfaces
 * produce working proxies, and does Flyway leave a schema Hibernate agrees with.
 * None of that can be answered without really starting.
 *
 * <p><strong>Needs a PostgreSQL, and skips without one.</strong> Same switch as
 * {@code OutboxClaimConcurrencyTest}: set {@code ORION_IT_DB_URL} and it
 * runs. There is no in-memory substitute available — the schema is fifty-odd
 * Flyway migrations of PostgreSQL, including {@code pgvector} columns, row-level
 * security policies and partial indexes, and every one of the native queries in
 * this codebase is PostgreSQL. An H2 that could load it would not be testing the
 * thing that runs.
 *
 * <p>It connects as the <em>owner</em> role, because Flyway runs on startup and
 * needs to. That is what the deployment does too.
 *
 * <h2>What is faked, and what that costs</h2>
 *
 * <p><strong>Kafka: not connected.</strong> The bootstrap address points nowhere
 * and the admin client's timeouts are turned down so it gives up in a second
 * instead of thirty. This is honest rather than convenient — {@code KafkaAdmin}
 * is already non-fatal by design, so an unreachable broker is a supported
 * startup condition, and the beans that matter here ({@code KafkaTemplate}, the
 * relay, the publisher) are constructed either way. What it does not prove is
 * that the SASL credentials work, which is a deployment question rather than a
 * wiring one.
 *
 * <p><strong>Object storage and the AI service: not called.</strong> Their
 * clients are built from configuration at construction and open no connection,
 * so they are real beans pointed at addresses nobody dials.
 *
 * <p><strong>The web layer: not started.</strong> {@code webEnvironment = NONE},
 * because the question is whether the beans exist, not whether they serve.
 *
 * <p>So: this proves the application context assembles against a real schema. It
 * does not prove the deployment's credentials, network or brokers are right.
 */
@SpringBootTest(
        classes = OrionApplication.class,
        webEnvironment = SpringBootTest.WebEnvironment.NONE)
@EnabledIfEnvironmentVariable(named = "ORION_IT_DB_URL", matches = ".+",
        disabledReason = "needs a PostgreSQL to migrate and map against")
class ApplicationContextSmokeTest {

    @DynamicPropertySource
    static void realDatabaseAndNoBroker(DynamicPropertyRegistry registry) {
        String url = System.getenv("ORION_IT_DB_URL");
        String owner = env("ORION_IT_DB_OWNER_USER", "ORION_IT_DB_USER");
        String password = env("ORION_IT_DB_OWNER_PASSWORD", "ORION_IT_DB_PASSWORD");

        // Flyway and both runtime pools. The tenant pool would normally be the
        // unprivileged role; here everything is the owner, because the point is
        // to load the context rather than to re-test row-level security, which
        // OutboxClaimConcurrencyTest covers against the real roles.
        registry.add("spring.datasource.url", () -> url);
        registry.add("spring.datasource.username", () -> owner);
        registry.add("spring.datasource.password", () -> password);
        registry.add("spring.flyway.url", () -> url);
        registry.add("spring.flyway.user", () -> owner);
        registry.add("spring.flyway.password", () -> password);
        registry.add("orion.datasource.system.username", () -> owner);
        registry.add("orion.datasource.system.password", () -> password);

        // Nowhere, quickly.
        registry.add("spring.kafka.bootstrap-servers", () -> "localhost:1");
        registry.add("spring.kafka.security.protocol", () -> "PLAINTEXT");
        registry.add("spring.kafka.properties.default.api.timeout.ms", () -> "1000");
        registry.add("spring.kafka.properties.request.timeout.ms", () -> "1000");
        registry.add("spring.kafka.admin.fail-fast", () -> "false");
        // Without this the admin client spends its full operation timeout trying
        // to create the topic against a broker that is not there. Topic creation
        // is a deployment concern; this test is about whether the beans exist.
        registry.add("spring.kafka.admin.auto-create", () -> "false");

        // The relay must not tick during the test: the database is shared with
        // the deployment and there is no broker to publish to.
        registry.add("orion.outbox.poll-ms", () -> "3600000");
    }

    private static String env(String preferred, String fallback) {
        String value = System.getenv(preferred);
        if (value == null || value.isBlank()) {
            value = System.getenv(fallback);
        }
        return value == null ? "" : value;
    }

    @Autowired private ApplicationContext context;

    @Test
    @DisplayName("the application context loads")
    void contextLoads() {
        assertThat(context).isNotNull();
    }

    @Test
    @DisplayName("the outbox is fully wired, constructors and all")
    void theOutboxIsWired() {
        // Named explicitly because this is the bug that prompted the test: the
        // publisher had two constructors and Spring could not choose, so the
        // container failed to start while every unit test stayed green.
        assertThat(context.getBean(OutboxPublisher.class)).isNotNull();
        assertThat(context.getBean(OutboxRelay.class)).isNotNull();
        assertThat(context.getBean(OutboxPurge.class)).isNotNull();
        assertThat(context.getBean(RetiredMeetingJobReconciler.class)).isNotNull();
        // A repository proxy, which only exists if the native @Query on it
        // parsed and the entity mapped against the migrated schema.
        assertThat(context.getBean(OutboxEventRepository.class)).isNotNull();
    }

    @Test
    @DisplayName("scheduled work has room for more than one job at a time")
    void theSchedulerIsNotASingleThread() {
        // A stalled outbox tick can hold its thread for the producer's delivery
        // timeout. On Boot's default pool of one that would postpone the nightly
        // retention pass, which is the job that applies each account's deletion
        // policy.
        ThreadPoolTaskScheduler scheduler = context.getBean(ThreadPoolTaskScheduler.class);
        assertThat(scheduler.getPoolSize()).isGreaterThan(1);
    }
}
