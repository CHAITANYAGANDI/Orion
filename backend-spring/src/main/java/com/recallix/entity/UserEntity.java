package com.recallix.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

@Entity
@Table(name = "users")
public class UserEntity {

    @Id
    private String id;

    @Column(name = "clerk_user_id", nullable = false, unique = true)
    private String clerkUserId;

    private String email;

    @Column(nullable = false)
    private String plan = "FREE";

    /** Mail the recap automatically when a meeting finishes processing. */
    @Column(name = "auto_email_recap", nullable = false)
    private boolean autoEmailRecap = false;

    /** Overrides {@link #email} as the recap destination when set. */
    @Column(name = "recap_email")
    private String recapEmail;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getClerkUserId() { return clerkUserId; }
    public void setClerkUserId(String clerkUserId) { this.clerkUserId = clerkUserId; }

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }

    public String getPlan() { return plan; }
    public void setPlan(String plan) { this.plan = plan; }

    public boolean isAutoEmailRecap() { return autoEmailRecap; }
    public void setAutoEmailRecap(boolean autoEmailRecap) { this.autoEmailRecap = autoEmailRecap; }

    public String getRecapEmail() { return recapEmail; }
    public void setRecapEmail(String recapEmail) { this.recapEmail = recapEmail; }

    /** Where recaps go: the override when set, otherwise the account address. */
    public String effectiveRecapEmail() {
        return recapEmail != null && !recapEmail.isBlank() ? recapEmail.trim() : email;
    }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
