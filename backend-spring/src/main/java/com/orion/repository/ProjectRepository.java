package com.orion.repository;

import com.orion.entity.Project;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface ProjectRepository extends JpaRepository<Project, String> {

    /**
     * Starred first, then alphabetical.
     *
     * <p>The order is fixed here rather than left to the client because the
     * sidebar and the folder list are the same list twice, and a workspace
     * whose folders were in one order in the rail and another on the page would
     * make somebody check they were looking at the same thing.
     */
    List<Project> findByUserIdOrderByFavoriteDescNameAsc(String userId);

    Optional<Project> findByIdAndUserId(String id, String userId);

    /**
     * The duplicate-name check, matching the unique index in V30.
     *
     * <p>Both are needed and neither is redundant: this one produces the error
     * message a person can act on, and the index is what makes the guarantee
     * true when two requests race. Case- and space-insensitive, because "Client
     * ABC" and "client abc " are the same project to everyone except a
     * character comparison.
     */
    @Query("""
            SELECT p FROM Project p
             WHERE p.userId = :userId
               AND LOWER(TRIM(p.name)) = LOWER(TRIM(:name))
            """)
    Optional<Project> findByUserIdAndName(@Param("userId") String userId, @Param("name") String name);

    long countByUserId(String userId);
}
