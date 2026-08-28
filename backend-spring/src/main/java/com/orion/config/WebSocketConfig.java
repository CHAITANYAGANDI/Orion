package com.orion.config;

import com.orion.security.StompAuthInterceptor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;

/**
 * STOMP over SockJS at {@code /ws}. The frontend subscribes to
 * {@code /topic/meetings/{meetingId}} to receive live {@code StatusEvent}s
 * (api-contracts §7).
 *
 * <p><b>The endpoint is public and the connection is not.</b> {@code /ws/**} is
 * {@code permitAll} in {@code SecurityConfig} because the SockJS handshake is a
 * plain GET that carries no credential — a browser cannot put a header on it.
 * Authentication happens one frame later, on {@code CONNECT}, and every
 * {@code SUBSCRIBE} is authorised against the account it established. See
 * {@link StompAuthInterceptor}, which is the whole of the access control here.
 */
@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    private final String frontendUrl;
    private final StompAuthInterceptor auth;

    public WebSocketConfig(@Value("${app.frontend-url:http://localhost:3000}") String frontendUrl,
                           StompAuthInterceptor auth) {
        this.frontendUrl = frontendUrl;
        this.auth = auth;
    }

    /**
     * Every frame the client sends passes through here first.
     *
     * <p>Inbound only, deliberately. Outbound is the broker fanning out to
     * subscriptions that have already been checked, so a second pass would be
     * work per message rather than work per subscription — and it would be
     * checking a decision this side already made.
     */
    @Override
    public void configureClientInboundChannel(ChannelRegistration registration) {
        registration.interceptors(auth);
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        registry.enableSimpleBroker("/topic");
        registry.setApplicationDestinationPrefixes("/app");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws")
                .setAllowedOrigins(frontendUrl)
                .withSockJS();
    }
}
