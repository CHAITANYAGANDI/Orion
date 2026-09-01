package com.reverie.service;

import com.reverie.repository.OutboxEventRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The sweep that keeps the outbox a queue rather than an archive.
 *
 * <p>What rows it may touch is enforced by the SQL, and proven against a real
 * PostgreSQL in {@code OutboxClaimConcurrencyTest} — a mock cannot demonstrate
 * that a predicate excludes a retired row. What is worth pinning here is the
 * shape of the job: the cutoff it computes, that it keeps going while there is
 * more, that it stops, and that it cannot kill the scheduler thread the relay
 * shares.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class OutboxPurgeTest {

    private static final Instant NOW = Instant.parse("2026-08-25T04:30:00Z");

    @Mock private OutboxEventRepository repo;

    private OutboxPurge purge(Duration keepFor) {
        return new OutboxPurge(repo, keepFor, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    @Test
    @DisplayName("deletes published events older than the retention window")
    void usesTheConfiguredCutoff() {
        when(repo.deletePublishedBefore(any(), anyInt())).thenReturn(0);

        purge(Duration.ofDays(7)).purge();

        ArgumentCaptor<Instant> cutoff = ArgumentCaptor.forClass(Instant.class);
        verify(repo).deletePublishedBefore(cutoff.capture(), anyInt());
        assertThat(cutoff.getValue()).isEqualTo(NOW.minus(Duration.ofDays(7)));
    }

    @Test
    @DisplayName("keeps going while a full batch comes back")
    void drainsInBatches() {
        // A full batch means there is probably more behind it. One unbounded
        // DELETE would be one long lock; this is the reason for the loop.
        when(repo.deletePublishedBefore(any(), anyInt()))
                .thenReturn(2000, 2000, 137);

        int removed = purge(Duration.ofDays(7)).purge();

        assertThat(removed).isEqualTo(4137);
        verify(repo, times(3)).deletePublishedBefore(any(), anyInt());
    }

    @Test
    @DisplayName("stops as soon as a batch comes back short")
    void stopsWhenThereIsNoMore() {
        when(repo.deletePublishedBefore(any(), anyInt())).thenReturn(0);

        purge(Duration.ofDays(7)).purge();

        verify(repo, times(1)).deletePublishedBefore(any(), anyInt());
    }

    @Test
    @DisplayName("and stops eventually even if there always is")
    void isBounded() {
        // Only reachable on a table nobody has ever swept. The point is that
        // this job ends and comes back tomorrow rather than running all night.
        when(repo.deletePublishedBefore(any(), anyInt())).thenReturn(2000);

        int removed = purge(Duration.ofDays(7)).purge();

        assertThat(removed).isEqualTo(200_000);
        verify(repo, times(100)).deletePublishedBefore(any(), anyInt());
    }

    @Test
    @DisplayName("a failure here never takes the scheduler thread down")
    void survivesItsOwnFailure() {
        // It shares that thread with the outbox relay. A tidying job that can
        // stop event publication is a worse problem than the untidiness.
        when(repo.deletePublishedBefore(any(), anyInt()))
                .thenThrow(new IllegalStateException("connection reset"));

        assertThatCode(() -> purge(Duration.ofDays(7)).purgePublished())
                .doesNotThrowAnyException();
    }
}
