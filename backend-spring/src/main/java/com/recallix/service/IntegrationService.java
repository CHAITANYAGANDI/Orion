package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.dto.IntegrationResponse;
import com.recallix.entity.AgentConnection;
import com.recallix.repository.AgentConnectionRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;

/**
 * Phase 2 (scaffolded): manages external integration connection state. Real
 * OAuth flows are stubbed — connect() marks the provider CONNECTED so the agent
 * approval UX is demoable without live provider credentials.
 */
@Service
public class IntegrationService {

    /** Supported providers (docs/phase2-agent-mcp.md). */
    public static final List<String> PROVIDERS = List.of(
            "notion", "gmail", "outlook_mail", "microsoft_tasks");

    private static final Map<String, List<String>> DEFAULT_SCOPES = Map.of(
            "notion", List.of("notes.write"),
            "gmail", List.of("gmail.compose"),
            "outlook_mail", List.of("Mail.Send"),
            "microsoft_tasks", List.of("Tasks.ReadWrite"));

    private final AgentConnectionRepository connections;
    private final AuditService audit;

    public IntegrationService(AgentConnectionRepository connections, AuditService audit) {
        this.connections = connections;
        this.audit = audit;
    }

    @Transactional(readOnly = true)
    public List<IntegrationResponse> list(String userId) {
        Map<String, AgentConnection> byProvider = connections.findByUserId(userId).stream()
                .collect(java.util.stream.Collectors.toMap(AgentConnection::getProvider, c -> c, (a, b) -> a));
        return PROVIDERS.stream()
                .map(p -> byProvider.containsKey(p)
                        ? IntegrationResponse.from(byProvider.get(p))
                        : IntegrationResponse.disconnected(p))
                .toList();
    }

    @Transactional
    public IntegrationResponse connect(String userId, String provider) {
        validate(provider);
        AgentConnection conn = connections.findByUserIdAndProvider(userId, provider)
                .orElseGet(() -> {
                    AgentConnection c = new AgentConnection();
                    c.setId(IdGenerator.connection());
                    c.setUserId(userId);
                    c.setProvider(provider);
                    return c;
                });
        conn.setStatus("CONNECTED");
        conn.setScopes(DEFAULT_SCOPES.getOrDefault(provider, List.of()));
        connections.save(conn);
        audit.record(userId, "INTEGRATION_CONNECTED", "integration", provider);
        return IntegrationResponse.from(conn);
    }

    @Transactional
    public void disconnect(String userId, String provider) {
        validate(provider);
        connections.findByUserIdAndProvider(userId, provider).ifPresent(conn -> {
            conn.setStatus("DISCONNECTED");
            connections.save(conn);
        });
        audit.record(userId, "INTEGRATION_DISCONNECTED", "integration", provider);
    }

    public boolean isConnected(String userId, String provider) {
        return connections.findByUserIdAndProvider(userId, provider)
                .map(c -> "CONNECTED".equals(c.getStatus()))
                .orElse(false);
    }

    private void validate(String provider) {
        if (!PROVIDERS.contains(provider)) {
            throw ApiException.badRequest("Unknown provider: " + provider);
        }
    }
}
