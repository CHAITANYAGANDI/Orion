package com.recallix.controller;

import com.recallix.dto.AgentActionResponse;
import com.recallix.dto.AgentPlanResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.AgentService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** Phase 2: agent action planning + approval/execution workflow. */
@RestController
public class AgentController {

    private final AgentService agent;

    public AgentController(AgentService agent) {
        this.agent = agent;
    }

    @PostMapping("/api/v1/meetings/{id}/agent/plan")
    public AgentPlanResponse plan(@PathVariable String id) {
        return agent.plan(SecurityUtils.currentUserId(), id);
    }

    @GetMapping("/api/v1/agent/actions")
    public List<AgentActionResponse> actions() {
        return agent.listActions(SecurityUtils.currentUserId());
    }

    @PostMapping("/api/v1/agent/actions/{id}/approve")
    public AgentActionResponse approve(@PathVariable String id) {
        return agent.approve(SecurityUtils.currentUserId(), id);
    }

    @PostMapping("/api/v1/agent/actions/{id}/execute")
    public AgentActionResponse execute(@PathVariable String id) {
        return agent.execute(SecurityUtils.currentUserId(), id);
    }
}
