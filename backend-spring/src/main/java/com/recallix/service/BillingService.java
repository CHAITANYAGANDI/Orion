package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.config.KafkaTopicsConfig;
import com.recallix.dto.CheckoutResponse;
import com.recallix.entity.Subscription;
import com.recallix.entity.UserEntity;
import com.recallix.repository.SubscriptionRepository;
import com.stripe.Stripe;
import com.stripe.model.Event;
import com.stripe.model.checkout.Session;
import com.stripe.net.Webhook;
import com.stripe.param.checkout.SessionCreateParams;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Map;
import java.util.Set;

/**
 * Stripe checkout + webhook. Degrades gracefully in dev: when no Stripe key is
 * configured the upgrade is applied immediately and a local success URL is
 * returned, so the whole flow is demoable without a Stripe account.
 */
@Service
public class BillingService {

    private static final Logger log = LoggerFactory.getLogger(BillingService.class);
    private static final Set<String> UPGRADE_PLANS = Set.of("PRO", "PREMIUM");

    private final UserService users;
    private final SubscriptionRepository subscriptions;
    private final AuditService audit;
    private final OutboxService outbox;

    private final String secretKey;
    private final String webhookSecret;
    private final String pricePro;
    private final String pricePremium;
    private final String frontendUrl;

    public BillingService(UserService users,
                          SubscriptionRepository subscriptions,
                          AuditService audit,
                          OutboxService outbox,
                          @Value("${stripe.secret-key:}") String secretKey,
                          @Value("${stripe.webhook-secret:}") String webhookSecret,
                          @Value("${stripe.price-pro:}") String pricePro,
                          @Value("${stripe.price-premium:}") String pricePremium,
                          @Value("${app.frontend-url:http://localhost:3000}") String frontendUrl) {
        this.users = users;
        this.subscriptions = subscriptions;
        this.audit = audit;
        this.outbox = outbox;
        this.secretKey = secretKey;
        this.webhookSecret = webhookSecret;
        this.pricePro = pricePro;
        this.pricePremium = pricePremium;
        this.frontendUrl = frontendUrl;
    }

    private boolean stripeConfigured() {
        return secretKey != null && !secretKey.isBlank();
    }

    @Transactional
    public CheckoutResponse createCheckout(String userId, String plan) {
        String normalized = plan == null ? "" : plan.trim().toUpperCase();
        if (!UPGRADE_PLANS.contains(normalized)) {
            throw ApiException.badRequest("plan must be PRO or PREMIUM");
        }

        if (!stripeConfigured()) {
            // Dev fallback: apply the upgrade now and return a local success URL.
            applyPlan(userId, normalized, null, null, "dev");
            audit.record(userId, "BILLING_UPGRADE_DEV", "subscription", normalized);
            return new CheckoutResponse(frontendUrl + "/billing?upgraded=" + normalized);
        }

        try {
            Stripe.apiKey = secretKey;
            String priceId = "PREMIUM".equals(normalized) ? pricePremium : pricePro;
            if (priceId == null || priceId.isBlank()) {
                throw ApiException.badRequest("No Stripe price configured for " + normalized);
            }
            UserEntity user = users.require(userId);
            SessionCreateParams params = SessionCreateParams.builder()
                    .setMode(SessionCreateParams.Mode.SUBSCRIPTION)
                    .setSuccessUrl(frontendUrl + "/billing?status=success")
                    .setCancelUrl(frontendUrl + "/billing?status=cancelled")
                    .setClientReferenceId(userId)
                    .setCustomerEmail(user.getEmail())
                    .putMetadata("userId", userId)
                    .putMetadata("plan", normalized)
                    .addLineItem(SessionCreateParams.LineItem.builder()
                            .setQuantity(1L)
                            .setPrice(priceId)
                            .build())
                    .build();
            Session session = Session.create(params);
            audit.record(userId, "BILLING_CHECKOUT_CREATED", "subscription", normalized);
            return new CheckoutResponse(session.getUrl());
        } catch (ApiException e) {
            throw e;
        } catch (Exception e) {
            log.error("Stripe checkout failed", e);
            throw new ApiException(org.springframework.http.HttpStatus.BAD_GATEWAY,
                    "STRIPE_ERROR", "Could not create checkout session");
        }
    }

    @Transactional
    public void handleWebhook(String payload, String signatureHeader) {
        if (!stripeConfigured() || webhookSecret == null || webhookSecret.isBlank()) {
            log.debug("Stripe webhook received but Stripe is not configured; ignoring.");
            return;
        }
        Event event;
        try {
            event = Webhook.constructEvent(payload, signatureHeader, webhookSecret);
        } catch (Exception e) {
            throw ApiException.badRequest("Invalid Stripe signature");
        }

        switch (event.getType()) {
            case "checkout.session.completed" -> event.getDataObjectDeserializer().getObject()
                    .filter(o -> o instanceof Session)
                    .map(o -> (Session) o)
                    .ifPresent(session -> {
                        String userId = session.getMetadata() != null ? session.getMetadata().get("userId") : null;
                        String plan = session.getMetadata() != null ? session.getMetadata().get("plan") : null;
                        if (userId != null && plan != null) {
                            applyPlan(userId, plan, session.getCustomer(), session.getSubscription(), "active");
                        }
                    });
            case "customer.subscription.deleted" -> {
                // Downgrade on cancellation.
                event.getDataObjectDeserializer().getObject().ifPresent(o -> {
                    String subId = tryGetId(o);
                    if (subId != null) {
                        subscriptions.findByStripeSubscriptionId(subId).ifPresent(sub -> {
                            users.updatePlan(sub.getUserId(), "FREE");
                            sub.setStatus("canceled");
                            sub.setPlan("FREE");
                        });
                    }
                });
            }
            default -> log.debug("Unhandled Stripe event: {}", event.getType());
        }
    }

    private void applyPlan(String userId, String plan, String customerId, String subscriptionId, String status) {
        users.updatePlan(userId, plan);
        Subscription sub = subscriptions.findFirstByUserIdOrderByCreatedAtDesc(userId)
                .orElseGet(() -> {
                    Subscription s = new Subscription();
                    s.setId(IdGenerator.subscription());
                    s.setUserId(userId);
                    return s;
                });
        sub.setStripeCustomerId(customerId);
        sub.setStripeSubscriptionId(subscriptionId);
        sub.setStatus(status);
        sub.setPlan(plan);
        subscriptions.save(sub);
        outbox.enqueue(KafkaTopicsConfig.PAYMENT_SUCCESSFUL, userId, Map.of("userId", userId, "plan", plan));
    }

    private static String tryGetId(Object stripeObject) {
        try {
            return (String) stripeObject.getClass().getMethod("getId").invoke(stripeObject);
        } catch (Exception e) {
            return null;
        }
    }
}
