package com.recallix.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;

import java.net.URI;

/**
 * S3 client + presigner. Configured with path-style access and a custom
 * endpoint so it works against MinIO in dev and real AWS S3 in prod.
 * The presigner uses the public endpoint so browsers can reach the URLs.
 */
@Configuration
public class S3Config {

    @Value("${s3.endpoint:http://localhost:9000}")
    private String endpoint;

    @Value("${s3.public-endpoint:http://localhost:9000}")
    private String publicEndpoint;

    @Value("${s3.access-key:minioadmin}")
    private String accessKey;

    @Value("${s3.secret-key:minioadmin}")
    private String secretKey;

    @Value("${s3.region:us-east-1}")
    private String region;

    private StaticCredentialsProvider credentials() {
        return StaticCredentialsProvider.create(AwsBasicCredentials.create(accessKey, secretKey));
    }

    private S3Configuration pathStyle() {
        return S3Configuration.builder().pathStyleAccessEnabled(true).build();
    }

    @Bean
    S3Client s3Client() {
        return S3Client.builder()
                .endpointOverride(URI.create(endpoint))
                .region(Region.of(region))
                .credentialsProvider(credentials())
                .serviceConfiguration(pathStyle())
                .build();
    }

    @Bean
    S3Presigner s3Presigner() {
        return S3Presigner.builder()
                .endpointOverride(URI.create(publicEndpoint))
                .region(Region.of(region))
                .credentialsProvider(credentials())
                .serviceConfiguration(pathStyle())
                .build();
    }
}
