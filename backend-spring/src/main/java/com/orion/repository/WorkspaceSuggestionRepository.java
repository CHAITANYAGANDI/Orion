package com.orion.repository;

import com.orion.entity.WorkspaceSuggestion;
import org.springframework.data.jpa.repository.JpaRepository;

public interface WorkspaceSuggestionRepository extends JpaRepository<WorkspaceSuggestion, String> {
}
