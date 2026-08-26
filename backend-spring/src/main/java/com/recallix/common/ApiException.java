package com.recallix.common;

import org.springframework.http.HttpStatus;

/** Base for expected, mapped API errors. */
public class ApiException extends RuntimeException {

    private final HttpStatus status;
    private final String errorCode;

    public ApiException(HttpStatus status, String errorCode, String message) {
        super(message);
        this.status = status;
        this.errorCode = errorCode;
    }

    public HttpStatus getStatus() {
        return status;
    }

    public String getErrorCode() {
        return errorCode;
    }

    public static ApiException notFound(String message) {
        return new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", message);
    }

    public static ApiException forbidden(String message) {
        return new ApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", message);
    }

    public static ApiException badRequest(String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, "BAD_REQUEST", message);
    }

    public static ApiException unauthorized(String message) {
        return new ApiException(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", message);
    }

    public static ApiException conflict(String message) {
        return new ApiException(HttpStatus.CONFLICT, "CONFLICT", message);
    }

    public static ApiException usageLimitReached(String message) {
        return new ApiException(HttpStatus.TOO_MANY_REQUESTS, "USAGE_LIMIT_REACHED", message);
    }

    /**
     * A dependency this request needed is not answering, so nothing was done.
     *
     * <p>503 rather than 500 because it says something true and useful: the
     * request was well formed, nothing was written, and trying again later is
     * the right response. Reserved for the case where refusing is the correct
     * outcome — see {@code SpeakerIdentityService.invalidateMeetingVoiceprintsRequired},
     * where saving the user's edit without the deletion that goes with it would
     * leave the account in a state the edit was meant to prevent.
     */
    public static ApiException serviceUnavailable(String message) {
        return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE", message);
    }
}
