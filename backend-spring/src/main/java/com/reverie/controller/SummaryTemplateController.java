package com.reverie.controller;

import com.reverie.dto.SummaryTemplateResponse;
import com.reverie.service.SummaryTemplateService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * The summary templates a user can pick from.
 *
 * <p>Deliberately not mounted under {@code /meetings} — a literal
 * {@code /meetings/templates} would sit next to {@code /meetings/{id}} and,
 * while Spring resolves the literal path first, it leaves a route that breaks
 * the day someone names a meeting "templates". The list is not about one
 * meeting anyway.
 */
@RestController
@RequestMapping("/api/v1/summary-templates")
public class SummaryTemplateController {

    private final SummaryTemplateService templates;

    public SummaryTemplateController(SummaryTemplateService templates) {
        this.templates = templates;
    }

    @GetMapping
    public List<SummaryTemplateResponse> list() {
        return templates.list().stream()
                .map(t -> new SummaryTemplateResponse(t.slug(), t.name(), t.sectionTitles()))
                .toList();
    }
}
