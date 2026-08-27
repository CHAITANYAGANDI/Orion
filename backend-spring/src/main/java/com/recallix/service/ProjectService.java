package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.dto.MeetingResponse;
import com.recallix.dto.ProjectRequest;
import com.recallix.dto.ProjectResponse;
import com.recallix.entity.Meeting;
import com.recallix.entity.Project;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.ProjectRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Projects, and what filing a meeting into one does.
 *
 * <p>The whole surface is small on purpose. A project is a name, a description
 * and a colour; everything interesting about it — what is in it, what was
 * decided across it, what you can ask it — is read from the meetings that point
 * at it, so there is nothing here to keep in step.
 */
@Service
public class ProjectService {

    /** Enough to organise a workspace; past this it is a filing system, not a plan. */
    static final int MAX_PROJECTS = 200;

    private final ProjectRepository projects;
    private final MeetingRepository meetings;
    private final AuditService audit;

    public ProjectService(ProjectRepository projects, MeetingRepository meetings, AuditService audit) {
        this.projects = projects;
        this.meetings = meetings;
        this.audit = audit;
    }

    @Transactional(readOnly = true)
    public List<ProjectResponse> list(String userId) {
        Map<String, Long> counts = countsByProject(userId);
        return projects.findByUserIdOrderByFavoriteDescNameAsc(userId).stream()
                .map(p -> ProjectResponse.from(p, counts.getOrDefault(p.getId(), 0L)))
                .toList();
    }

    @Transactional(readOnly = true)
    public ProjectResponse get(String userId, String projectId) {
        Project p = owned(userId, projectId);
        return ProjectResponse.from(p, countsByProject(userId).getOrDefault(projectId, 0L));
    }

    /** One project's meetings, newest first. */
    @Transactional(readOnly = true)
    public List<MeetingResponse> meetings(String userId, String projectId) {
        owned(userId, projectId);
        return meetings.findByUserIdAndProjectIdOrderByCreatedAtDesc(userId, projectId).stream()
                .map(MeetingResponse::from)
                .toList();
    }

    /**
     * Everything filed nowhere.
     *
     * <p>Shown at the bottom of the tree rather than hidden. A grouping feature
     * that makes unfiled meetings harder to find has cost the user more than it
     * gave them, and this is also the list somebody works through when they
     * first create a project.
     */
    @Transactional(readOnly = true)
    public List<MeetingResponse> unfiled(String userId) {
        return meetings.findUnfiled(userId).stream()
                .map(MeetingResponse::from)
                .toList();
    }

    @Transactional
    public ProjectResponse create(String userId, ProjectRequest req) {
        String name = req.nameOrNull();
        if (name == null) {
            throw ApiException.badRequest("A project needs a name.");
        }
        if (projects.countByUserId(userId) >= MAX_PROJECTS) {
            throw ApiException.badRequest("You already have " + MAX_PROJECTS + " projects.");
        }
        requireNameFree(userId, name, null);

        Project p = new Project();
        p.setId(IdGenerator.project());
        p.setUserId(userId);
        p.setName(name);
        p.setDescription(req.description() == null ? "" : req.description().trim());
        p.setColor(req.color() == null ? "" : req.color().trim());
        projects.save(p);

        audit.record(userId, "PROJECT_CREATED", "project", p.getId());
        return ProjectResponse.from(p, 0);
    }

    @Transactional
    public ProjectResponse update(String userId, String projectId, ProjectRequest req) {
        Project p = owned(userId, projectId);

        String name = req.nameOrNull();
        if (name != null) {
            requireNameFree(userId, name, projectId);
            p.setName(name);
        }
        if (req.description() != null) {
            p.setDescription(req.description().trim());
        }
        if (req.color() != null) {
            p.setColor(req.color().trim());
        }
        if (req.favorite() != null) {
            p.setFavorite(req.favorite());
        }

        audit.record(userId, "PROJECT_UPDATED", "project", projectId);
        return ProjectResponse.from(p, countsByProject(userId).getOrDefault(projectId, 0L));
    }

    /**
     * Delete a project. The meetings survive it.
     *
     * <p>The schema would do this on its own — {@code ON DELETE SET NULL} — but
     * it is done explicitly first so the count comes back, and so the intent is
     * stated where somebody reading the service can see it. Nobody tidying a
     * sidebar is asking to destroy six hours of audio.
     *
     * @return how many meetings were unfiled, so the UI can say so rather than
     *         leaving the user to wonder what happened to them.
     */
    @Transactional
    public int delete(String userId, String projectId) {
        Project p = owned(userId, projectId);
        int unfiled = meetings.clearProject(userId, projectId);
        projects.delete(p);
        audit.record(userId, "PROJECT_DELETED", "project", projectId);
        return unfiled;
    }

    /**
     * File a meeting, or take it out of its project.
     *
     * <p>Both sides are checked before anything moves: the meeting must be the
     * caller's, and so must the project. Without the second check a valid
     * meeting id and a guessed project id would file somebody else's work into
     * your sidebar — and then answer questions from it.
     *
     * <p>Both the project it leaves and the project it joins are stamped. The
     * folder list shows "Last Updated", and without this the column reads as
     * the day the project was named however much has been filed into it since.
     */
    @Transactional
    public MeetingResponse assign(String userId, String meetingId, String projectId) {
        Meeting m = meetings.findByIdAndUserId(meetingId, userId)
                .orElseThrow(() -> ApiException.notFound("Meeting not found"));
        if (projectId != null) {
            owned(userId, projectId);
        }
        String previous = m.getProjectId();
        m.setProjectId(projectId);
        touch(userId, previous);
        touch(userId, projectId);
        audit.record(userId, projectId == null ? "MEETING_UNFILED" : "MEETING_FILED",
                "meeting", meetingId);
        return MeetingResponse.from(m);
    }

    // --- helpers ------------------------------------------------------------ //

    private Map<String, Long> countsByProject(String userId) {
        Map<String, Long> counts = new HashMap<>();
        for (Object[] row : meetings.countByProject(userId)) {
            counts.put((String) row[0], ((Number) row[1]).longValue());
        }
        return counts;
    }

    /**
     * Mark a project as having changed, for the "Last Updated" column.
     *
     * <p>Silent about a project id that no longer resolves: this is called on
     * the way out of a project as well as into one, and a meeting whose old
     * project was deleted underneath it must still be filable.
     */
    private void touch(String userId, String projectId) {
        if (projectId == null) {
            return;
        }
        projects.findByIdAndUserId(projectId, userId).ifPresent(p -> p.setUpdatedAt(Instant.now()));
    }

    private Project owned(String userId, String projectId) {
        return projects.findByIdAndUserId(projectId, userId)
                // The same answer as for one that never existed, so a 404 never
                // confirms somebody else's project is there.
                .orElseThrow(() -> ApiException.notFound("Project not found"));
    }

    /**
     * Refuse a duplicate name before the unique index does.
     *
     * <p>The index in V30 is what makes this true under a race; this is what
     * makes the failure something a person can act on. "Client ABC" already
     * exists is a sentence; a constraint-violation stack trace is not.
     */
    private void requireNameFree(String userId, String name, String allowedId) {
        Optional<Project> clash = projects.findByUserIdAndName(userId, name);
        if (clash.isPresent() && !clash.get().getId().equals(allowedId)) {
            throw ApiException.conflict("You already have a project called “" + name + "”.");
        }
    }
}
