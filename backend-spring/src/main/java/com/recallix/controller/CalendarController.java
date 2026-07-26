package com.recallix.controller;

import com.recallix.dto.CalendarEventResponse;
import com.recallix.dto.CalendarSubscribeRequest;
import com.recallix.dto.CalendarSubscriptionResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.CalendarService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** Connected calendars and the meetings they hold. All owner-scoped. */
@RestController
@RequestMapping("/api/v1/calendars")
public class CalendarController {

    private final CalendarService calendars;

    public CalendarController(CalendarService calendars) {
        this.calendars = calendars;
    }

    @GetMapping
    public List<CalendarSubscriptionResponse> list() {
        return calendars.list(SecurityUtils.currentUserId());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public CalendarSubscriptionResponse subscribe(@Valid @RequestBody CalendarSubscribeRequest req) {
        return calendars.subscribe(SecurityUtils.currentUserId(), req);
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void unsubscribe(@PathVariable String id) {
        calendars.unsubscribe(SecurityUtils.currentUserId(), id);
    }

    /** Upcoming meetings across every connected calendar. */
    @GetMapping("/events")
    public List<CalendarEventResponse> events(@RequestParam(defaultValue = "7") int days) {
        return calendars.upcoming(SecurityUtils.currentUserId(), days);
    }
}
