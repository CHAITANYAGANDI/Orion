package com.reverie.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.info.License;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OpenApiConfig {

    @Bean
    OpenAPI reverieOpenApi() {
        return new OpenAPI().info(new Info()
                .title("Reverie AI — Business API")
                .description("Meeting summarizer & action-item extractor. Orchestrates the FastAPI AI worker via Kafka.")
                .version("0.1.0")
                .license(new License().name("MIT")));
    }
}
