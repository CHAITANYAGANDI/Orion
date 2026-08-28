package com.orion.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.Executor;

/**
 * Executor for post-commit background work — currently the recap email, which
 * calls the ai-service and must never delay the internal callback that
 * triggered it.
 *
 * <p>The queue is bounded and the rejection policy is caller-runs, so a backlog
 * slows the work down rather than silently dropping meetings.
 */
@Configuration
@EnableAsync
public class AsyncConfig {

    @Bean(name = "postCommitExecutor")
    public Executor postCommitExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(2);
        executor.setMaxPoolSize(4);
        executor.setQueueCapacity(100);
        executor.setThreadNamePrefix("post-commit-");
        executor.setRejectedExecutionHandler(
                new java.util.concurrent.ThreadPoolExecutor.CallerRunsPolicy());
        executor.initialize();
        return executor;
    }
}
