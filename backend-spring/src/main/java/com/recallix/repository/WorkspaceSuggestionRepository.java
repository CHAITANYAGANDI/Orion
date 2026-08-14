package com.recallix.repository;

import com.recallix.entity.WorkspaceSuggestion;
import org.springframework.data.jpa.repository.JpaRepository;

public interface WorkspaceSuggestionRepository extends JpaRepository<WorkspaceSuggestion, String> {
}
