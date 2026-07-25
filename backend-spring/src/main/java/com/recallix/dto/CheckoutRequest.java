package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;

public record CheckoutRequest(
        @NotBlank String plan   // PRO | PREMIUM
) {
}
