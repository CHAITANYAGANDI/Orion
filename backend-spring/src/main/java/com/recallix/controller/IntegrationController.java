package com.recallix.controller;

import com.recallix.dto.IntegrationResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.IntegrationService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** Phase 2: manage external app connections (docs/phase2-agent-mcp.md). */
@RestController
@RequestMapping("/api/v1/integrations")
public class IntegrationController {

    private final IntegrationService integrations;

    public IntegrationController(IntegrationService integrations) {
        this.integrations = integrations;
    }

    @GetMapping
    public List<IntegrationResponse> list() {
        return integrations.list(SecurityUtils.currentUserId());
    }

    @PostMapping("/{provider}/connect")
    public IntegrationResponse connect(@PathVariable String provider) {
        return integrations.connect(SecurityUtils.currentUserId(), provider);
    }

    @DeleteMapping("/{provider}")
    public ResponseEntity<Void> disconnect(@PathVariable String provider) {
        integrations.disconnect(SecurityUtils.currentUserId(), provider);
        return ResponseEntity.noContent().build();
    }
}
