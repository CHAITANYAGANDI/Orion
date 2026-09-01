package com.reverie.repository;

import com.reverie.entity.SpeakerProfile;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

/**
 * Reading and deleting voice profiles. There is no write path here on purpose.
 *
 * <p>Profiles are created and updated by the ai-service, which holds the
 * encryption key and the embedding model. Spring's half of the feature is the
 * half a user can see: what is held, and getting rid of it.
 *
 * <p>Every method is scoped by {@code userId}. Row-level security would refuse a
 * cross-tenant read anyway (V53 puts a FORCEd policy on the table with no
 * system bypass), but the belt is here too — a repository method that takes only
 * an id is the shape that eventually gets called from somewhere that forgot to
 * check, and this way there is no such method to call.
 */
public interface SpeakerProfileRepository extends JpaRepository<SpeakerProfile, String> {

    List<SpeakerProfile> findByUserIdOrderByUpdatedAtDesc(String userId);

    Optional<SpeakerProfile> findByIdAndUserId(String id, String userId);

    long countByUserId(String userId);

    void deleteByUserId(String userId);
}
