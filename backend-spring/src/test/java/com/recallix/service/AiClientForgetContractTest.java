package com.recallix.service;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * What Spring believes when the ai-service answers a deletion.
 *
 * <p>Everywhere else {@code AiClient} is a mock, so the one thing never
 * exercised is the part that reads the wire — and that is where the decision
 * lives. The endpoint answers {@code deleted: 0} both for a meeting that had
 * nothing cached and for a service with no database behind it, so the count
 * cannot be read as proof; {@code confirmed} can. A manual speaker correction
 * refuses to save on the strength of this parse, so the parse is worth a real
 * socket.
 *
 * <p>A throwaway JDK {@link HttpServer} on an ephemeral port, which needs no
 * dependency and is honest about the transport: the client really serialises,
 * really connects, and really deserialises.
 */
class AiClientForgetContractTest {

    private HttpServer server;
    private AiClient client;
    private final AtomicReference<String> lastBody = new AtomicReference<>();
    private final AtomicReference<String> response = new AtomicReference<>("{}");
    private final AtomicReference<Integer> status = new AtomicReference<>(200);

    @BeforeEach
    void startTheFarEnd() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/ai/speakers/forget", exchange -> {
            try (InputStream in = exchange.getRequestBody()) {
                lastBody.set(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            }
            byte[] body = response.get().getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(status.get(), body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        client = new AiClient("http://127.0.0.1:" + server.getAddress().getPort());
    }

    @AfterEach
    void stopIt() {
        server.stop(0);
    }

    private void answers(String json) {
        response.set(json);
    }

    @Test
    @DisplayName("a confirmed deletion is reported as one")
    void confirmedIsCarriedThrough() {
        answers("{\"deleted\": 2, \"confirmed\": true}");

        AiClient.ForgetResult result = client.forgetMeetingVoiceprints("usr_1", "mtg_1");

        assertThat(result.deleted()).isEqualTo(2);
        assertThat(result.confirmed()).isTrue();
    }

    @Test
    @DisplayName("removing nothing is still a confirmed deletion")
    void zeroRowsCanBeConfirmed() {
        // The distinction the field exists for, from the good side: a meeting
        // that was never rematched has no cached voiceprints to drop, and the
        // caller's requirement — no stale vector — is satisfied.
        answers("{\"deleted\": 0, \"confirmed\": true}");

        assertThat(client.forgetMeetingVoiceprints("usr_1", "mtg_1").confirmed()).isTrue();
    }

    @Test
    @DisplayName("and the identical count without confirmation is not")
    void zeroRowsUnconfirmed() {
        answers("{\"deleted\": 0, \"confirmed\": false}");

        assertThat(client.forgetMeetingVoiceprints("usr_1", "mtg_1").confirmed()).isFalse();
    }

    @Test
    @DisplayName("an ai-service too old to say is read as 'it did not happen'")
    void anAbsentFieldFailsClosed() {
        // The rolling-deploy case, and deliberately fail-closed. A service that
        // cannot tell us what it deleted has to be treated the same as one that
        // deleted nothing: during a deploy that costs a few refused corrections,
        // where guessing the other way costs a real person's name on the wrong
        // voice, discovered weeks later with nothing in the transcript to
        // explain it.
        answers("{\"deleted\": 4}");

        AiClient.ForgetResult result = client.forgetMeetingVoiceprints("usr_1", "mtg_1");

        assertThat(result.deleted()).isEqualTo(4);
        assertThat(result.confirmed()).isFalse();
    }

    @Test
    @DisplayName("an empty body is not a confirmation either")
    void anEmptyBodyFailsClosed() {
        answers("{}");

        assertThat(client.forgetMeetingVoiceprints("usr_1", "mtg_1").confirmed()).isFalse();
    }

    @Test
    @DisplayName("a server error throws rather than returning an unconfirmed zero")
    void serverErrorsThrow() {
        // Both refusals reach the user the same way, but they are different
        // facts and the logs should keep them apart: this one is "we do not
        // know", the unconfirmed answer above is "it did not happen".
        answers("{\"detail\": \"boom\"}");
        status.set(500);

        assertThatThrownBy(() -> client.forgetMeetingVoiceprints("usr_1", "mtg_1"))
                .isInstanceOf(RuntimeException.class);

        status.set(200);
    }

    @Test
    @DisplayName("the request asks for one meeting and no profile")
    void theRequestIsScoped() {
        answers("{\"deleted\": 1, \"confirmed\": true}");

        client.forgetMeetingVoiceprints("usr_1", "mtg_1");

        // A correction says a voice was in the wrong place, not that the account
        // should forget who anyone is. A profile id here would delete a named
        // voice the user spent a meeting establishing.
        assertThat(lastBody.get()).contains("\"meetingId\":\"mtg_1\"");
        assertThat(lastBody.get()).contains("\"userId\":\"usr_1\"");
        assertThat(lastBody.get()).contains("\"profileId\":null");
    }

    @Test
    @DisplayName("the count-only call still behaves exactly as it did")
    void theOldCallIsUnchanged() {
        // Erasure and account closure still use this one, and still ignore the
        // confirmation. Their contract did not move.
        answers("{\"deleted\": 7, \"confirmed\": false}");

        assertThat(client.forgetSpeakers("usr_1", null, "mtg_1")).isEqualTo(7);
    }
}
