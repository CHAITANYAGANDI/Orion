package com.reverie.dto;

/**
 * POST /api/v1/streaming/token — a short-lived AssemblyAI streaming credential.
 *
 * <p>The token is the only secret here and it is meant to leave the building:
 * that is what it is for. {@code expiresInSeconds} lets the client decide
 * whether the one it holds is still worth trying, rather than finding out from
 * a refused websocket.
 */
public record StreamingTokenResponse(String token, int expiresInSeconds) {}
