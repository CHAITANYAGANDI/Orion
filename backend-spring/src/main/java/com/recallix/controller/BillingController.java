package com.recallix.controller;

import com.recallix.dto.CheckoutRequest;
import com.recallix.dto.CheckoutResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.BillingService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/billing")
public class BillingController {

    private final BillingService billing;

    public BillingController(BillingService billing) {
        this.billing = billing;
    }

    @PostMapping("/checkout")
    public CheckoutResponse checkout(@Valid @RequestBody CheckoutRequest req) {
        return billing.createCheckout(SecurityUtils.currentUserId(), req.plan());
    }

    /** Public endpoint (permitted in SecurityConfig); verified via Stripe signature. */
    @PostMapping("/webhook")
    public ResponseEntity<Void> webhook(@RequestBody String payload,
                                        @RequestHeader(value = "Stripe-Signature", required = false) String signature) {
        billing.handleWebhook(payload, signature);
        return ResponseEntity.ok().build();
    }
}
