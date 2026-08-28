package com.orion.dto;

public record UploadUrlResponse(
        String meetingId,
        String uploadUrl,
        String objectKey,
        long expiresInSeconds
) {
}
