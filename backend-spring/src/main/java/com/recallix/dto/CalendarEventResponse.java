package com.recallix.dto;

import com.recallix.service.IcsParser;

import java.time.Instant;

/** One upcoming meeting from a subscribed calendar. */
public record CalendarEventResponse(
        String uid,
        String title,
        Instant start,
        Instant end,
        String location,
        /** Join link when the event has one, so the UI can offer "Join & record". */
        String meetingUrl,
        boolean allDay,
        /** Which subscription it came from, for the badge in the list. */
        String calendarLabel
) {
    public static CalendarEventResponse from(IcsParser.CalendarEvent e, String calendarLabel) {
        return new CalendarEventResponse(
                e.uid(), e.title(), e.start(), e.end(),
                e.location(), e.meetingUrl(), e.allDay(), calendarLabel);
    }
}
