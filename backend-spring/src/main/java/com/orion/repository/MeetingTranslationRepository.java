package com.orion.repository;

import com.orion.entity.MeetingTranslation;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface MeetingTranslationRepository extends JpaRepository<MeetingTranslation, String> {

    Optional<MeetingTranslation> findByMeetingIdAndLanguage(String meetingId, String language);

    List<MeetingTranslation> findByMeetingIdOrderByLanguageAsc(String meetingId);

    void deleteByMeetingId(String meetingId);

    /**
     * Mark every translation of a meeting as describing text that has changed.
     *
     * <p>One statement rather than a read-modify-write per row: this runs from
     * the transcript editor, where somebody correcting twenty segments would
     * otherwise pay for twenty round trips per language they have translated
     * into. Nothing is re-translated here — that is a model call the user did
     * not ask for, and the same argument V25 made about summaries.
     */
    @Modifying
    @Query("UPDATE MeetingTranslation t SET t.stale = true WHERE t.meetingId = :meetingId AND t.stale = false")
    void markStaleByMeetingId(@Param("meetingId") String meetingId);
}
