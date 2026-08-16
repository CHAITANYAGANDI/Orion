package com.recallix.service;

import com.recallix.export.Downloads;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.GetBucketEncryptionRequest;
import software.amazon.awssdk.services.s3.model.GetBucketEncryptionResponse;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.PutBucketEncryptionRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.ServerSideEncryptionByDefault;
import software.amazon.awssdk.services.s3.model.ServerSideEncryptionConfiguration;
import software.amazon.awssdk.services.s3.model.ServerSideEncryptionRule;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest;
import software.amazon.awssdk.services.s3.presigner.model.PutObjectPresignRequest;

import java.time.Duration;
import java.util.Optional;

/** Presigned S3 upload/download URLs + object deletion (works with MinIO). */
@Service
public class StorageService {

    private static final Logger log = LoggerFactory.getLogger(StorageService.class);

    private final S3Client s3;
    private final S3Presigner presigner;
    private final String bucket;
    private final long presignExpirySeconds;
    /** {@code AES256}, {@code aws:kms}, or blank to leave the bucket as it is. */
    private final String defaultEncryption;
    private final String kmsKeyId;

    public StorageService(S3Client s3,
                          S3Presigner presigner,
                          @Value("${s3.bucket:recallix}") String bucket,
                          @Value("${s3.presign-expiry-seconds:900}") long presignExpirySeconds,
                          @Value("${s3.default-encryption:}") String defaultEncryption,
                          @Value("${s3.kms-key-id:}") String kmsKeyId) {
        this.s3 = s3;
        this.presigner = presigner;
        this.bucket = bucket;
        this.presignExpirySeconds = presignExpirySeconds;
        this.defaultEncryption = defaultEncryption;
        this.kmsKeyId = kmsKeyId;
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
        return presignDownload(objectKey, null);
    }

    /**
     * The same, but the browser saves it under {@code downloadFilename} instead
     * of playing it.
     *
     * <p>The disposition is signed into the URL rather than set by us on the
     * way past, because there is no way past: the browser fetches the object
     * from storage directly. S3 and MinIO both let a presigned GET override the
     * response headers, and this is the only thing that turns a link into a
     * download with a name on it — the HTML {@code download} attribute is
     * ignored cross-origin.
     */
    public String presignDownload(String objectKey, String downloadFilename) {
        GetObjectRequest.Builder get = GetObjectRequest.builder()
                .bucket(bucket)
                .key(objectKey);
        if (downloadFilename != null && !downloadFilename.isBlank()) {
            get.responseContentDisposition(Downloads.attachment(downloadFilename));
        }
        GetObjectPresignRequest presignRequest = GetObjectPresignRequest.builder()
                .signatureDuration(Duration.ofSeconds(presignExpirySeconds))
                .getObjectRequest(get.build())
                .build();
        return presigner.presignGetObject(presignRequest).url().toString();
    }

    /**
     * What the bucket actually does about encryption at rest, read from the
     * bucket rather than from our own configuration.
     *
     * <p>This distinction is the whole point. "Encrypted storage" is the easiest
     * claim in the industry to make and the easiest to get wrong: the setting
     * lives on the bucket, the bucket is created by whoever runs the deployment,
     * and an application that prints its own intent has told the reader nothing
     * about what is true. So the privacy page asks the object store and repeats
     * the answer — including "not configured", which is what a default MinIO in
     * docker-compose will say, and which is worth seeing.
     *
     * @return the SSE algorithm the bucket applies by default, or empty when it
     *         applies none or will not say
     */
    public Optional<String> encryptionAtRest() {
        try {
            GetBucketEncryptionResponse response = s3.getBucketEncryption(
                    GetBucketEncryptionRequest.builder().bucket(bucket).build());
            for (ServerSideEncryptionRule rule : response.serverSideEncryptionConfiguration().rules()) {
                ServerSideEncryptionByDefault applied = rule.applyServerSideEncryptionByDefault();
                if (applied != null && applied.sseAlgorithmAsString() != null
                        && !applied.sseAlgorithmAsString().isBlank()) {
                    return Optional.of(applied.sseAlgorithmAsString());
                }
            }
            return Optional.empty();
        } catch (Exception e) {
            // Both "no encryption configured" and "this object store does not
            // implement the call" arrive here, and neither is an error worth a
            // stack trace: the honest answer to the page is the same either way.
            log.debug("Bucket {} reports no default encryption: {}", bucket, e.toString());
            return Optional.empty();
        }
    }

    /**
     * Ask the bucket to encrypt everything it stores from now on.
     *
     * <p>Run once at startup and only when {@code s3.default-encryption} is set,
     * so a deployment that manages its bucket policy elsewhere — which is most
     * real ones — is left alone. Applied on the bucket rather than per upload
     * because the upload is a presigned PUT performed by a browser: signing an
     * encryption header into it would require the browser to send it back
     * byte-identical, and any client that did not would have its uploads
     * rejected by a signature mismatch it could do nothing about.
     */
    @PostConstruct
    void applyDefaultEncryption() {
        if (defaultEncryption == null || defaultEncryption.isBlank()) {
            return;
        }
        try {
            ServerSideEncryptionByDefault.Builder byDefault = ServerSideEncryptionByDefault.builder()
                    .sseAlgorithm(defaultEncryption.trim());
            if (kmsKeyId != null && !kmsKeyId.isBlank()) {
                byDefault.kmsMasterKeyID(kmsKeyId.trim());
            }
            s3.putBucketEncryption(PutBucketEncryptionRequest.builder()
                    .bucket(bucket)
                    .serverSideEncryptionConfiguration(ServerSideEncryptionConfiguration.builder()
                            .rules(ServerSideEncryptionRule.builder()
                                    .applyServerSideEncryptionByDefault(byDefault.build())
                                    .build())
                            .build())
                    .build());
            log.info("Default encryption {} applied to bucket {}.", defaultEncryption, bucket);
        } catch (Exception e) {
            // Loud, and not fatal. An operator who asked for encryption and did
            // not get it needs to know; an application that refuses to start
            // over it takes the whole product down over a setting the privacy
            // page will now honestly report as absent.
            log.error("Could not apply default encryption {} to bucket {}: {}",
                    defaultEncryption, bucket, e.toString());
        }
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
