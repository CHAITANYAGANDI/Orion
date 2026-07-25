package com.recallix.controller;

import com.recallix.dto.UsageResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.UsageLimitService;
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
