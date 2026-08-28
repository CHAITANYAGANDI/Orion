package com.orion.common;

import com.orion.dto.ErrorResponse;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.stream.Collectors;

/** Produces the shared error envelope with a correlationId for every failure. */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ErrorResponse> handleApi(ApiException ex, HttpServletRequest request) {
        return build(ex.getStatus(), ex.getErrorCode(), ex.getMessage(), request);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> handleValidation(MethodArgumentNotValidException ex,
                                                           HttpServletRequest request) {
        String message = ex.getBindingResult().getFieldErrors().stream()
                .map(this::formatFieldError)
                .collect(Collectors.joining("; "));
        return build(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR",
                message.isBlank() ? "Validation failed" : message, request);
    }

    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<ErrorResponse> handleAccessDenied(AccessDeniedException ex,
                                                            HttpServletRequest request) {
        return build(HttpStatus.FORBIDDEN, "FORBIDDEN", "Access denied", request);
    }

    /**
     * A URL that maps to nothing is a 404, not a 500.
     *
     * <p>Without this, the catch-all below turns every unknown path into
     * "an unexpected error occurred", which tells a client the server broke
     * when in fact it answered correctly — and buries a real 500 among the
     * noise of typos and stale links. It also logs at ERROR, so a crawler can
     * fill the log with alarms about nothing.
     *
     * <p>Logged at DEBUG because a request for a route that does not exist is
     * normal traffic, not a fault.
     */
    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<ErrorResponse> handleNotFound(NoResourceFoundException ex,
                                                        HttpServletRequest request) {
        log.debug("No handler for {} {}", request.getMethod(), request.getRequestURI());
        return build(HttpStatus.NOT_FOUND, "NOT_FOUND", "Not found", request);
    }

    /**
     * The right path, the wrong verb.
     *
     * <p>Unhandled, this fell to {@link #handleUnexpected} and came back a 500 —
     * a server fault for what is plainly a bad request, logged at ERROR with a
     * stack trace every time. It surfaces most often on a route that has been
     * withdrawn while a path variable still matches the URL: {@code POST
     * /meetings/import} now resolves against {@code GET /meetings/&#123;id&#125;},
     * and a client that had not noticed deserves to be told which of the two
     * things it got wrong.
     */
    @ExceptionHandler(org.springframework.web.HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<ErrorResponse> handleMethodNotAllowed(
            org.springframework.web.HttpRequestMethodNotSupportedException ex,
            HttpServletRequest request) {
        log.debug("{} not supported for {}", request.getMethod(), request.getRequestURI());
        return build(HttpStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED",
                request.getMethod() + " is not supported here", request);
    }

    /**
     * A query parameter the server could not read as the type it is declared as.
     *
     * <p>Third of the same kind as the two above, and the same fault: unhandled,
     * {@code ?status=NONSENSE} or {@code ?from=notadate} fell through to
     * {@link #handleUnexpected} and came back "an unexpected error occurred" —
     * a server fault for a request the client got wrong, logged at ERROR with a
     * stack trace each time. Nothing about it is unexpected.
     *
     * <p>The parameter is named because it is the only useful thing to say: a
     * client sending a date in the wrong format cannot tell from a bare 400
     * which of several it should look at. The offending *value* is not echoed —
     * it came from the caller and reflecting it into a response body is how a
     * reflected-XSS gets its foothold.
     */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<ErrorResponse> handleTypeMismatch(MethodArgumentTypeMismatchException ex,
                                                            HttpServletRequest request) {
        log.debug("Bad value for parameter {} on {}", ex.getName(), request.getRequestURI());
        return build(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR",
                "'" + ex.getName() + "' is not in a format this endpoint accepts", request);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleUnexpected(Exception ex, HttpServletRequest request) {
        log.error("Unhandled exception [correlationId={}]", CorrelationIdFilter.current(), ex);
        return build(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR",
                "An unexpected error occurred", request);
    }

    private String formatFieldError(FieldError fe) {
        return fe.getField() + ": " + fe.getDefaultMessage();
    }

    private ResponseEntity<ErrorResponse> build(HttpStatus status, String error, String message,
                                                HttpServletRequest request) {
        ErrorResponse body = ErrorResponse.of(
                status.value(), error, message,
                request.getRequestURI(), CorrelationIdFilter.current());
        return ResponseEntity.status(status).body(body);
    }
}
