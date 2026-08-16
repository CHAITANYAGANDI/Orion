package com.recallix.controller;

import com.recallix.dto.MeetingResponse;
import com.recallix.dto.ProjectAssignRequest;
import com.recallix.dto.ProjectRequest;
import com.recallix.dto.ProjectResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.ProjectService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * Projects — the bodies of work meetings are filed into.
 *
 * <p>Filing lives here rather than on the meeting resource because it is a
 * statement about the project as much as the meeting, and because expressing
 * "take it out of its project" through a PATCH that ignores omitted fields is
 * not possible — see {@link ProjectAssignRequest}.
 */
@RestController
@RequestMapping("/api/v1/projects")
public class ProjectController {

    private final ProjectService projects;

    public ProjectController(ProjectService projects) {
        this.projects = projects;
    }

    @GetMapping
    public List<ProjectResponse> list() {
        return projects.list(SecurityUtils.currentUserId());
    }

    /** Meetings filed nowhere. Kept beside the projects, not hidden behind them. */
    @GetMapping("/unfiled")
    public List<MeetingResponse> unfiled() {
        return projects.unfiled(SecurityUtils.currentUserId());
    }

    @GetMapping("/{id}")
    public ProjectResponse get(@PathVariable String id) {
        return projects.get(SecurityUtils.currentUserId(), id);
    }

    @GetMapping("/{id}/meetings")
    public List<MeetingResponse> meetings(@PathVariable String id) {
        return projects.meetings(SecurityUtils.currentUserId(), id);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ProjectResponse create(@Valid @RequestBody ProjectRequest req) {
        return projects.create(SecurityUtils.currentUserId(), req);
    }

    @PatchMapping("/{id}")
    public ProjectResponse update(@PathVariable String id, @Valid @RequestBody ProjectRequest req) {
        return projects.update(SecurityUtils.currentUserId(), id, req);
    }

    /**
     * Delete a project. Its meetings are unfiled, not deleted.
     *
     * <p>Returns how many rather than a 204, so the UI can say "3 meetings moved
     * to Unfiled" instead of leaving somebody to wonder whether they just lost
     * three recordings.
     */
    @DeleteMapping("/{id}")
    public Map<String, Integer> delete(@PathVariable String id) {
        return Map.of("unfiledMeetings", projects.delete(SecurityUtils.currentUserId(), id));
    }

    /** File a meeting into this project, or send {@code null} to unfile it. */
    @PutMapping("/meetings/{meetingId}")
    public MeetingResponse assign(@PathVariable String meetingId,
                                  @RequestBody ProjectAssignRequest req) {
        return projects.assign(SecurityUtils.currentUserId(), meetingId, req.targetOrNull());
    }
}
