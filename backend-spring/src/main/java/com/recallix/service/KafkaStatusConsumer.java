package com.recallix.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.stereotype.Component;

/**
 * Observability consumer for the AI worker's stage topics (api-contracts §6).
 * DB persistence and WS relay are driven by the internal HTTP callbacks
 * ({@link CallbackService}); this listener records the same events for
 * traceability/metrics without duplicating writes.
 */
@Component
public class KafkaStatusConsumer {

    private static final Logger log = LoggerFactory.getLogger(KafkaStatusConsumer.class);

    @KafkaListener(topics = {
            "transcription_started",
            "transcription_completed",
            "summary_generated",
            "action_items_extracted"
    }, groupId = "recallix-backend")
    public void onStatus(@Payload String message) {
        log.info("[kafka] stage event: {}", message);
    }

    @KafkaListener(topics = "meeting_processing_failed", groupId = "recallix-backend")
    public void onFailure(@Payload String message) {
        log.warn("[kafka] processing failed: {}", message);
    }

    @KafkaListener(topics = {"payment_successful", "usage_limit_reached"}, groupId = "recallix-backend")
    public void onBilling(@Payload String message) {
        log.info("[kafka] billing/usage event: {}", message);
    }
}
