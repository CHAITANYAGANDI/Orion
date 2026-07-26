package com.recallix.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.Executor;

/**
 * Executor for post-commit background work — currently Meeting Memory
 * reconciliation, which calls the ai-service and must never delay the internal
 * callback that triggered it.
 *
 * <p>The queue is bounded and the rejection policy is caller-runs, so a backlog
 * slows reconciliation down rather than silently dropping meetings.
 */
@Configuration
@EnableAsync
public class AsyncConfig {

    @Bean(name = "memoryExecutor")
    public Executor memoryExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(2);
        executor.setMaxPoolSize(4);
        executor.setQueueCapacity(100);
        executor.setThreadNamePrefix("memory-");
        executor.setRejectedExecutionHandler(
                new java.util.concurrent.ThreadPoolExecutor.CallerRunsPolicy());
        executor.initialize();
        return executor;
    }
}
