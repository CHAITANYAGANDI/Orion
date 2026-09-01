package com.reverie.service;

import com.reverie.common.ApiException;
import com.reverie.dto.ProjectRequest;
import com.reverie.dto.ProjectResponse;
import com.reverie.entity.Meeting;
import com.reverie.entity.Project;
import com.reverie.repository.MeetingRepository;
import com.reverie.repository.ProjectRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Filing meetings into projects.
 *
 * <p>One failure here is worse than all the others and it is the reason for
 * most of these tests: deleting a project that takes its meetings with it. The
 * user's mental model is a folder, folders are cheap to delete, and the
 * recordings behind them are not recoverable. Everything else — a duplicate
 * name, an unowned id — is an annoyance by comparison.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ProjectServiceTest {

    private static final String USER = "usr_1";
    private static final String OTHER = "usr_2";
    private static final String PROJECT = "prj_1";
    private static final String MEETING = "mtg_1";

    @Mock private ProjectRepository projects;
    @Mock private MeetingRepository meetings;
    @Mock private AuditService audit;

    private ProjectService service;
    private final List<Project> stored = new ArrayList<>();

    @BeforeEach
    void setUp() {
        service = new ProjectService(projects, meetings, audit);
        stored.clear();

        Project existing = new Project();
        existing.setId(PROJECT);
        existing.setUserId(USER);
        existing.setName("Client ABC");
        stored.add(existing);

        when(projects.save(any())).thenAnswer(inv -> {
            stored.add(inv.getArgument(0));
            return inv.getArgument(0);
        });
        when(projects.findByIdAndUserId(anyString(), anyString())).thenAnswer(inv ->
                stored.stream()
                        .filter(p -> p.getId().equals(inv.getArgument(0))
                                && p.getUserId().equals(inv.getArgument(1)))
                        .findFirst());
        when(projects.findByUserIdAndName(anyString(), anyString())).thenAnswer(inv -> {
            String name = ((String) inv.getArgument(1)).trim();
            return stored.stream()
                    .filter(p -> p.getUserId().equals(inv.getArgument(0))
                            && p.getName().trim().equalsIgnoreCase(name))
                    .findFirst();
        });
        when(projects.findByUserIdOrderByFavoriteDescNameAsc(USER)).thenAnswer(inv -> List.copyOf(stored));
        when(projects.countByUserId(anyString())).thenAnswer(inv -> (long) stored.size());
        when(meetings.countByProject(anyString())).thenReturn(List.of());

        Meeting m = new Meeting();
        m.setId(MEETING);
        m.setUserId(USER);
        when(meetings.findByIdAndUserId(anyString(), anyString())).thenAnswer(inv ->
                USER.equals(inv.getArgument(1)) && MEETING.equals(inv.getArgument(0))
                        ? Optional.of(m)
                        : Optional.empty());
    }

    private static ProjectRequest named(String name) {
        return new ProjectRequest(name, null, null, null);
    }

    @Nested
    class Creating {

        @Test
        @DisplayName("a project needs a name")
        void nameIsRequired() {
            assertThatThrownBy(() -> service.create(USER, named("   ")))
                    .isInstanceOf(ApiException.class);
            assertThatThrownBy(() -> service.create(USER, named(null)))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("the name is trimmed")
        void nameIsTrimmed() {
            assertThat(service.create(USER, named("  Interviews  ")).name()).isEqualTo("Interviews");
        }

        @Test
        @DisplayName("a duplicate name is refused, whatever its case or spacing")
        void refusesDuplicates() {
            // "Client ABC" and "client abc " are the same project to everyone
            // except a character comparison — and two identical rows in a
            // sidebar is where half of somebody's meetings go missing.
            assertThatThrownBy(() -> service.create(USER, named("client abc ")))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("already have a project");
        }

        @Test
        @DisplayName("a name another user has taken is free")
        void namesAreScopedToTheUser() {
            assertThat(service.create(OTHER, named("Client ABC")).name()).isEqualTo("Client ABC");
        }

        @Test
        @DisplayName("a new project starts empty")
        void startsEmpty() {
            assertThat(service.create(USER, named("Interviews")).meetingCount()).isZero();
        }
    }

    @Nested
    class Editing {

        @Test
        @DisplayName("renaming to its own name is allowed")
        void canKeepItsOwnName() {
            // Otherwise saving a description would fail on the name it already has.
            ProjectResponse updated = service.update(USER, PROJECT,
                    new ProjectRequest("Client ABC", "The ABC engagement", null, null));

            assertThat(updated.description()).isEqualTo("The ABC engagement");
        }

        @Test
        @DisplayName("renaming onto another project is refused")
        void cannotCollideWithAnother() {
            service.create(USER, named("Interviews"));
            String interviews = stored.get(stored.size() - 1).getId();

            assertThatThrownBy(() -> service.update(USER, interviews, named("Client ABC")))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("an omitted field is left alone")
        void omittedFieldsSurvive() {
            service.update(USER, PROJECT, new ProjectRequest(null, "A description", null, null));

            assertThat(stored.get(0).getName()).isEqualTo("Client ABC");
            assertThat(stored.get(0).getDescription()).isEqualTo("A description");
        }

        @Test
        @DisplayName("starring a project does not rename it")
        void canStar() {
            ProjectResponse starred = service.update(USER, PROJECT,
                    new ProjectRequest(null, null, null, true));

            assertThat(starred.favorite()).isTrue();
            assertThat(starred.name()).isEqualTo("Client ABC");
        }

        @Test
        @DisplayName("a rename leaves the star where it was")
        void renameDoesNotUnstar() {
            // The field is boxed for exactly this: an omitted `favorite` has to
            // be distinguishable from `false`, or every rename silently unstars.
            service.update(USER, PROJECT, new ProjectRequest(null, null, null, true));

            ProjectResponse renamed = service.update(USER, PROJECT, named("ABC Ltd"));

            assertThat(renamed.favorite()).isTrue();
        }

        @Test
        @DisplayName("another user's project is not found")
        void cannotEditSomebodyElses() {
            assertThatThrownBy(() -> service.update(OTHER, PROJECT, named("Mine now")))
                    .isInstanceOf(ApiException.class);
        }
    }

    @Nested
    class Deleting {

        @Test
        @DisplayName("deleting a project unfiles its meetings rather than deleting them")
        void meetingsSurvive() {
            when(meetings.clearProject(USER, PROJECT)).thenReturn(3);

            int unfiled = service.delete(USER, PROJECT);

            // Nobody tidying a sidebar is asking to destroy six hours of audio.
            verify(meetings).clearProject(USER, PROJECT);
            verify(meetings, never()).deleteAll(any());
            assertThat(unfiled).isEqualTo(3);
        }

        @Test
        @DisplayName("another user's project is not found")
        void cannotDeleteSomebodyElses() {
            assertThatThrownBy(() -> service.delete(OTHER, PROJECT))
                    .isInstanceOf(ApiException.class);
            verify(projects, never()).delete(any());
        }
    }

    @Nested
    class Filing {

        @Test
        @DisplayName("a meeting can be filed")
        void files() {
            assertThat(service.assign(USER, MEETING, PROJECT).projectId()).isEqualTo(PROJECT);
        }

        @Test
        @DisplayName("a null project unfiles it")
        void unfiles() {
            service.assign(USER, MEETING, PROJECT);
            assertThat(service.assign(USER, MEETING, null).projectId()).isNull();
        }

        @Test
        @DisplayName("filing into an unowned project is refused")
        void checksTheProjectToo() {
            // A valid meeting id and a guessed project id would otherwise put
            // this recording in somebody else's sidebar — and inside the answers
            // their project chat gives.
            Project theirs = new Project();
            theirs.setId("prj_theirs");
            theirs.setUserId(OTHER);
            stored.add(theirs);

            assertThatThrownBy(() -> service.assign(USER, MEETING, "prj_theirs"))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("filing another user's meeting is refused")
        void checksTheMeeting() {
            assertThatThrownBy(() -> service.assign(OTHER, MEETING, PROJECT))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("filing marks the project as updated")
        void filingTouchesTheProject() throws Exception {
            Instant before = stored.get(0).getUpdatedAt();
            Thread.sleep(5);

            service.assign(USER, MEETING, PROJECT);

            // The folder list has a "Last Updated" column. Without this it reads
            // as the day the project was named however much is filed into it.
            assertThat(stored.get(0).getUpdatedAt()).isAfter(before);
        }

        @Test
        @DisplayName("unfiling marks the project it left")
        void unfilingTouchesTheOldProject() throws Exception {
            service.assign(USER, MEETING, PROJECT);
            Instant afterFiling = stored.get(0).getUpdatedAt();
            Thread.sleep(5);

            service.assign(USER, MEETING, null);

            assertThat(stored.get(0).getUpdatedAt()).isAfter(afterFiling);
        }

        @Test
        @DisplayName("a meeting whose old project is gone can still be filed")
        void survivesAMissingOldProject() {
            Meeting orphan = new Meeting();
            orphan.setId(MEETING);
            orphan.setUserId(USER);
            orphan.setProjectId("prj_deleted");
            when(meetings.findByIdAndUserId(MEETING, USER)).thenReturn(Optional.of(orphan));

            assertThat(service.assign(USER, MEETING, PROJECT).projectId()).isEqualTo(PROJECT);
        }
    }

    @Nested
    class Listing {

        @Test
        @DisplayName("counts come from one read, not one per project")
        void countsAreBatched() {
            // Explicitly typed: List.of with one array argument spreads it, and
            // the varargs call infers List<Object> rather than List<Object[]>.
            when(meetings.countByProject(USER))
                    .thenReturn(List.<Object[]>of(new Object[]{PROJECT, 4L}));

            List<ProjectResponse> list = service.list(USER);

            assertThat(list).singleElement()
                    .satisfies(p -> assertThat(p.meetingCount()).isEqualTo(4));
            verify(meetings).countByProject(USER);
        }

        @Test
        @DisplayName("a project with nothing in it counts zero")
        void emptyProjectsCountZero() {
            assertThat(service.list(USER).get(0).meetingCount()).isZero();
        }
    }
}
