package com.recallix.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * A calendar connected over OAuth, as opposed to a published iCal URL.
 *
 * <p>Both kinds coexist. iCal needs no app registration and reaches any
 * provider; OAuth gives attendee lists, near-real-time changes, and an account
 * identity to attach a recording bot to. Neither supersedes the other, and
 * {@code CalendarService.upcoming} merges them.
 *
 * <p>The token fields hold ciphertext produced by {@code TokenCipher}, never
 * plaintext. Nothing on this entity should ever be logged whole.
 */
@Entity
@Table(name = "calendar_accounts")
public class CalendarAccount {

    @Id
    private String id;

    @Column(name = "user_id", nullable = false)
    private String userId;

    /** {@code google} or {@code microsoft}. */
    @Column(nullable = false)
    private String provider;

    /**
     * The provider's own account id. Paired with {@code provider} this makes a
     * reconnect update the existing row rather than create a second one, so a
     * user who re-runs the flow does not end up with their calendar twice.
     */
    @Column(name = "external_account_id", nullable = false)
    private String externalAccountId;

    @Column(name = "account_email")
    private String accountEmail;

    @Column(name = "access_token_enc")
    private String accessTokenEnc;

    @Column(name = "refresh_token_enc")
    private String refreshTokenEnc;

    @Column(name = "access_expires_at")
    private Instant accessExpiresAt;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "scopes_json", columnDefinition = "jsonb")
    private List<String> scopes = new ArrayList<>();

    /**
     * Set when the grant is gone for good — revoked in the provider's console,
     * consent withdrawn, password reset. Retrying those forever only earns rate
     * limits, so this parks the account and the UI asks for a reconnect.
     */
    @Column(name = "last_error")
    private String lastError;

    @Column(name = "last_synced_at")
    private Instant lastSyncedAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    @PreUpdate
    void onUpdate() {
        this.updatedAt = Instant.now();
    }

    /**
     * Whether the access token needs renewing before the next call.
     *
     * <p>Renewed a minute early on purpose: a token that expires between the
     * check and the request arriving at the provider fails a sync for no reason,
     * and the clocks involved are not the same clock.
     */
    public boolean accessTokenExpired() {
        return accessExpiresAt == null || Instant.now().plusSeconds(60).isAfter(accessExpiresAt);
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getProvider() { return provider; }
    public void setProvider(String provider) { this.provider = provider; }

    public String getExternalAccountId() { return externalAccountId; }
    public void setExternalAccountId(String externalAccountId) {
        this.externalAccountId = externalAccountId;
    }

    public String getAccountEmail() { return accountEmail; }
    public void setAccountEmail(String accountEmail) { this.accountEmail = accountEmail; }

    public String getAccessTokenEnc() { return accessTokenEnc; }
    public void setAccessTokenEnc(String accessTokenEnc) { this.accessTokenEnc = accessTokenEnc; }

    public String getRefreshTokenEnc() { return refreshTokenEnc; }
    public void setRefreshTokenEnc(String refreshTokenEnc) { this.refreshTokenEnc = refreshTokenEnc; }

    public Instant getAccessExpiresAt() { return accessExpiresAt; }
    public void setAccessExpiresAt(Instant accessExpiresAt) { this.accessExpiresAt = accessExpiresAt; }

    public List<String> getScopes() { return scopes; }
    public void setScopes(List<String> scopes) { this.scopes = scopes; }

    public String getLastError() { return lastError; }
    public void setLastError(String lastError) { this.lastError = lastError; }

    public Instant getLastSyncedAt() { return lastSyncedAt; }
    public void setLastSyncedAt(Instant lastSyncedAt) { this.lastSyncedAt = lastSyncedAt; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
