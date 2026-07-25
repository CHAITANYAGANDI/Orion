package com.recallix.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest;
import software.amazon.awssdk.services.s3.presigner.model.PutObjectPresignRequest;

import java.time.Duration;

/** Presigned S3 upload/download URLs + object deletion (works with MinIO). */
@Service
public class StorageService {

    private static final Logger log = LoggerFactory.getLogger(StorageService.class);

    private final S3Client s3;
    private final S3Presigner presigner;
    private final String bucket;
    private final long presignExpirySeconds;

    public StorageService(S3Client s3,
                          S3Presigner presigner,
                          @Value("${s3.bucket:recallix}") String bucket,
                          @Value("${s3.presign-expiry-seconds:900}") long presignExpirySeconds) {
        this.s3 = s3;
        this.presigner = presigner;
        this.bucket = bucket;
        this.presignExpirySeconds = presignExpirySeconds;
    }

    public long presignExpirySeconds() {
        return presignExpirySeconds;
    }

    /** Presigned PUT URL for the browser to upload the audio directly to S3. */
    public String presignUpload(String objectKey, String contentType) {
        PutObjectRequest put = PutObjectRequest.builder()
                .bucket(bucket)
                .key(objectKey)
                .contentType(contentType)
                .build();
        PutObjectPresignRequest presignRequest = PutObjectPresignRequest.builder()
                .signatureDuration(Duration.ofSeconds(presignExpirySeconds))
                .putObjectRequest(put)
                .build();
        return presigner.presignPutObject(presignRequest).url().toString();
    }

    /** Presigned GET URL so the frontend / AI worker can read the object. */
    public String presignDownload(String objectKey) {
        GetObjectRequest get = GetObjectRequest.builder()
                .bucket(bucket)
                .key(objectKey)
                .build();
        GetObjectPresignRequest presignRequest = GetObjectPresignRequest.builder()
                .signatureDuration(Duration.ofSeconds(presignExpirySeconds))
                .getObjectRequest(get)
                .build();
        return presigner.presignGetObject(presignRequest).url().toString();
    }

    public void delete(String objectKey) {
        if (objectKey == null || objectKey.isBlank()) {
            return;
        }
        try {
            s3.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(objectKey).build());
        } catch (Exception e) {
            log.warn("Failed to delete S3 object {}: {}", objectKey, e.getMessage());
        }
    }
}
