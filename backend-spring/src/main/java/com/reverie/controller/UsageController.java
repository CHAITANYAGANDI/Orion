package com.reverie.controller;

import com.reverie.dto.UsageResponse;
import com.reverie.security.SecurityUtils;
import com.reverie.service.UsageLimitService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/usage")
public class UsageController {

    private final UsageLimitService usage;

    public UsageController(UsageLimitService usage) {
        this.usage = usage;
    }

    @GetMapping
    public UsageResponse usage() {
        return usage.getUsage(SecurityUtils.currentUserId());
    }
}
