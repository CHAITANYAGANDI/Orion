package com.recallix.dto;

import com.recallix.entity.AgentConnection;

import java.time.Instant;

/** Phase 2: an external integration's connection state. */
public record IntegrationResponse(
        String provider,
        String status,      // CONNECTED | DISCONNECTED
        Instant connectedAt
) {
    public static IntegrationResponse from(AgentConnection c) {
        boolean connected = "CONNECTED".equals(c.getStatus());
        return new IntegrationResponse(
                c.getProvider(),
                c.getStatus(),
                connected ? c.getUpdatedAt() : null
        );
    }

    public static IntegrationResponse disconnected(String provider) {
        return new IntegrationResponse(provider, "DISCONNECTED", null);
    }
}
