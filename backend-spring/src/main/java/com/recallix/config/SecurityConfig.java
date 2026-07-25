package com.recallix.config;

import com.recallix.security.AuthenticationFilter;
import com.recallix.security.InternalTokenFilter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.List;

/**
 * Stateless security. Public: landing, actuator, swagger, WS handshake, Stripe
 * webhook, and internal callbacks (guarded separately by {@link InternalTokenFilter}).
 * Everything under {@code /api/v1/**} requires an authenticated user resolved by
 * {@link AuthenticationFilter}.
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    private final AuthenticationFilter authenticationFilter;
    private final InternalTokenFilter internalTokenFilter;
    private final String frontendUrl;

    public SecurityConfig(AuthenticationFilter authenticationFilter,
                          InternalTokenFilter internalTokenFilter,
                          @Value("${app.frontend-url:http://localhost:3000}") String frontendUrl) {
        this.authenticationFilter = authenticationFilter;
        this.internalTokenFilter = internalTokenFilter;
        this.frontendUrl = frontendUrl;
    }

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
                .cors(cors -> cors.configurationSource(corsConfigurationSource()))
                .csrf(AbstractHttpConfigurer::disable)
                .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(
                                "/", "/error",
                                "/actuator/**",
                                "/swagger-ui/**", "/swagger-ui.html",
                                "/v3/api-docs/**", "/v3/api-docs",
                                "/ws/**",
                                "/internal/**"
                        ).permitAll()
                        .requestMatchers(HttpMethod.POST, "/api/v1/billing/webhook").permitAll()
                        .anyRequest().authenticated()
                )
                .addFilterBefore(internalTokenFilter, UsernamePasswordAuthenticationFilter.class)
                .addFilterBefore(authenticationFilter, UsernamePasswordAuthenticationFilter.class)
                .exceptionHandling(ex -> ex.authenticationEntryPoint((request, response, authException) -> {
                    response.setStatus(401);
                    response.setContentType("application/json");
                    response.getWriter().write(
                            "{\"status\":401,\"error\":\"UNAUTHORIZED\",\"message\":\"Authentication required\"}");
                }));
        return http.build();
    }

    @Bean
    CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(List.of(frontendUrl));
        config.setAllowedMethods(List.of("GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("*"));
        config.setExposedHeaders(List.of("X-Correlation-Id"));
        config.setAllowCredentials(true);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", config);
        return source;
    }

    // Prevent the servlet container from auto-registering the custom filters a
    // second time; they run only inside the Spring Security chain above.
    @Bean
    FilterRegistrationBean<AuthenticationFilter> authFilterRegistration(AuthenticationFilter filter) {
        FilterRegistrationBean<AuthenticationFilter> reg = new FilterRegistrationBean<>(filter);
        reg.setEnabled(false);
        return reg;
    }

    @Bean
    FilterRegistrationBean<InternalTokenFilter> internalFilterRegistration(InternalTokenFilter filter) {
        FilterRegistrationBean<InternalTokenFilter> reg = new FilterRegistrationBean<>(filter);
        reg.setEnabled(false);
        return reg;
    }
}
