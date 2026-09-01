package com.reverie.repository;

import com.reverie.entity.WorkspaceSuggestion;
import org.springframework.data.jpa.repository.JpaRepository;

public interface WorkspaceSuggestionRepository extends JpaRepository<WorkspaceSuggestion, String> {
}
