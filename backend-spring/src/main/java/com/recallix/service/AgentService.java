package com.recallix.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.dto.AgentActionResponse;
import com.recallix.dto.AgentPlanResponse;
import com.recallix.entity.AgentActionRequest;
import com.recallix.entity.ExternalSyncLog;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.repository.AgentActionRequestRepository;
import com.recallix.repository.ExternalSyncLogRepository;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingSummaryRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Phase 2 (scaffolded): turns a processed meeting into a set of draft external
 * actions (Notion note, follow-up email, tasks, calendar event). Actions are
 * created in DRAFT and require explicit approval, then execution. External calls
 * are stubbed and recorded in {@code external_sync_logs} (human-in-the-loop).
 */
@Service
public class AgentService {

    private static final Logger log = LoggerFactory.getLogger(AgentService.class);

    private final AgentActionRequestRepository actions;
    private final ExternalSyncLogRepository syncLogs;
    private final MeetingRepository meetings;
    private final MeetingSummaryRepository summaries;
    private final MeetingActionItemRepository actionItems;
    private final IntegrationService integrations;
    private final AuditService audit;
    private final ObjectMapper mapper;

    public AgentService(AgentActionRequestRepository actions,
                        ExternalSyncLogRepository syncLogs,
                        MeetingRepository meetings,
                        MeetingSummaryRepository summaries,
                        MeetingActionItemRepository actionItems,
                        IntegrationService integrations,
                        AuditService audit,
                        ObjectMapper mapper) {
        this.actions = actions;
        this.syncLogs = syncLogs;
        this.meetings = meetings;
        this.summaries = summaries;
        this.actionItems = actionItems;
        this.integrations = integrations;
        this.audit = audit;
        this.mapper = mapper;
    }

    @Transactional
    public AgentPlanResponse plan(String userId, String meetingId) {
        Meeting meeting = meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));

        String summary = summaries.findFirstByMeetingIdOrderByCreatedAtDesc(meetingId)
                .map(s -> s.getShortSummary()).orElse("Meeting summary");
        List<MeetingActionItem> items = actionItems.findByMeetingId(meetingId);

        List<AgentActionResponse> planned = new ArrayList<>();
        planned.add(draft(userId, meetingId, "CREATE_NOTION_NOTE", "notion",
                node -> node.put("title", meeting.getTitle() + " — Meeting Notes")
                        .put("body", summary)));
        planned.add(draft(userId, meetingId, "DRAFT_EMAIL", "gmail",
                node -> node.put("subject", "Follow-up: " + meeting.getTitle())
                        .put("body", "Hi team,\n\n" + summary + "\n\nSee the action items below.")));
        planned.add(draft(userId, meetingId, "CREATE_TASKS", "microsoft_tasks",
                node -> node.put("title", "Action items from " + meeting.getTitle())
                        .put("taskCount", items.size())));
        planned.add(draft(userId, meetingId, "CREATE_CALENDAR_EVENT", "google_calendar",
                node -> node.put("title", meeting.getTitle() + " — Follow-up")));

        audit.record(userId, "AGENT_PLAN_CREATED", "meeting", meetingId);
        return new AgentPlanResponse(meetingId, true, planned);
    }

    @Transactional(readOnly = true)
    public List<AgentActionResponse> listActions(String userId) {
        return actions.findByUserIdOrderByCreatedAtDesc(userId).stream()
                .map(AgentActionResponse::from).toList();
    }

    @Transactional
    public AgentActionResponse approve(String userId, String actionId) {
        AgentActionRequest action = require(userId, actionId);
        if (!"DRAFT".equals(action.getStatus())) {
            throw ApiException.badRequest("Only DRAFT actions can be approved");
        }
        action.setStatus("APPROVED");
        audit.record(userId, "AGENT_ACTION_APPROVED", "agent_action", actionId);
        return AgentActionResponse.from(action);
    }

    @Transactional
    public AgentActionResponse execute(String userId, String actionId) {
        AgentActionRequest action = require(userId, actionId);
        if (!"APPROVED".equals(action.getStatus())) {
            throw ApiException.badRequest("Action must be APPROVED before execution");
        }
        if (!integrations.isConnected(userId, action.getProvider())) {
            recordSync(userId, action, "FAILED", null, action.getProvider() + " is not connected");
            action.setStatus("FAILED");
            throw ApiException.badRequest("Integration not connected: " + action.getProvider());
        }

        // Stubbed external execution (no live provider call in this scaffold).
        String externalId = "ext_" + IdGenerator.generate("");
        action.setStatus("EXECUTED");
        action.setExecutedAt(Instant.now());
        recordSync(userId, action, "SUCCESS", externalId, null);
        audit.record(userId, "AGENT_ACTION_EXECUTED", "agent_action", actionId);
        log.info("Executed agent action {} ({}) -> {}", actionId, action.getActionType(), externalId);
        return AgentActionResponse.from(action);
    }

    // --- helpers ------------------------------------------------------------ //

    private AgentActionResponse draft(String userId, String meetingId, String type, String provider,
                                      java.util.function.Consumer<ObjectNode> payloadBuilder) {
        ObjectNode payload = mapper.createObjectNode();
        payloadBuilder.accept(payload);
        AgentActionRequest action = new AgentActionRequest();
        action.setId(IdGenerator.agentAction());
        action.setUserId(userId);
        action.setMeetingId(meetingId);
        action.setActionType(type);
        action.setProvider(provider);
        action.setDraftPayload(payload);
        action.setStatus("DRAFT");
        action.setApprovalRequired(true);
        actions.save(action);
        return AgentActionResponse.from(action);
    }

    private AgentActionRequest require(String userId, String actionId) {
        return actions.findByIdAndUserId(actionId, userId)
                .orElseThrow(() -> ApiException.notFound("Agent action not found"));
    }

    private void recordSync(String userId, AgentActionRequest action, String status,
                            String externalId, String error) {
        ExternalSyncLog entry = new ExternalSyncLog();
        entry.setId(IdGenerator.syncLog());
        entry.setUserId(userId);
        entry.setProvider(action.getProvider());
        entry.setExternalEntityId(externalId);
        entry.setActionRequestId(action.getId());
        entry.setStatus(status);
        entry.setErrorMessage(error);
        syncLogs.save(entry);
    }
}
