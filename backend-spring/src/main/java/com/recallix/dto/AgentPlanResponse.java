package com.recallix.dto;

import java.util.List;

/** Phase 2: POST /api/v1/meetings/{id}/agent/plan */
public record AgentPlanResponse(
        String meetingId,
        boolean requiresApproval,
        List<AgentActionResponse> actions
) {
}
