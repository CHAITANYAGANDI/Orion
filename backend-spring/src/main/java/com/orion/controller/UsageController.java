package com.orion.controller;

import com.orion.dto.UsageResponse;
import com.orion.security.SecurityUtils;
import com.orion.service.UsageLimitService;
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
