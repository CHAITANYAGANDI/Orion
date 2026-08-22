package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.entity.UsageLimit;
import com.recallix.repository.UsageLimitRepository;
import com.recallix.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

/**
 * What an account is allowed, and what happens at the edge of it.
 *
 * <p>The allowance is a lifetime one: 100 transcribed minutes and 3 imports,
 * every account, no rollover. It replaced five meetings a calendar month, and
 * the two differ in ways worth pinning down rather than trusting:
 *
 * <ul>
 *   <li>A recording is no longer refused for being the eleventh. Length is what
 *       it costs, so the minutes are the only thing that can stop it.</li>
 *   <li>Imports are counted separately, and a browser recording is not one.</li>
 *   <li>A file whose length is known and does not fit is refused now, rather
 *       than accepted and discovered to be over afterwards.</li>
 * </ul>
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class UsageAllowanceTest {

    private static final String USER = "usr_1";

    @Mock private UsageLimitRepository usage;
    @Mock private UserRepository users;

    private UsageLimitService service;
    private UsageLimit row;

    @BeforeEach
    void setUp() {
        row = new UsageLimit();
        row.setId("usg_1");
        row.setUserId(USER);
        when(usage.findByUserId(USER)).thenReturn(Optional.of(row));
        when(usage.save(any(UsageLimit.class))).thenAnswer(i -> i.getArgument(0));
        service = new UsageLimitService(usage, users);
    }

    @Test
    @DisplayName("a recording spends minutes and no import")
    void recordingSpendsNoImport() {
        service.chargeMeetingOrThrow(USER, true, 600);

        assertThat(row.getImportsUsed()).isZero();
        assertThat(row.getMeetingsUsed()).isEqualTo(1);
    }

    @Test
    @DisplayName("an imported file spends one of three")
    void importSpendsAnImport() {
        service.chargeMeetingOrThrow(USER, false, 600);

        assertThat(row.getImportsUsed()).isEqualTo(1);
    }

    @Test
    @DisplayName("the fourth import is refused, and says what still works")
    void fourthImportIsRefused() {
        row.setImportsUsed(3);

        assertThatThrownBy(() -> service.chargeMeetingOrThrow(USER, false, 60))
                .isInstanceOf(ApiException.class)
                // Somebody at their import limit still has an hour of minutes
                // and a working microphone. A refusal that does not say so
                // reads as the account being finished.
                .hasMessageContaining("Recording in the browser still works");
    }

    @Test
    @DisplayName("a recording is allowed once the imports are gone")
    void recordingSurvivesSpentImports() {
        row.setImportsUsed(3);

        service.chargeMeetingOrThrow(USER, true, 60);

        assertThat(row.getMeetingsUsed()).isEqualTo(1);
    }

    @Test
    @DisplayName("nothing is allowed once the minutes are gone")
    void spentMinutesRefuseEverything() {
        row.setAiMinutesUsed(UsageLimitService.MINUTES_ALLOWANCE);

        assertThatThrownBy(() -> service.chargeMeetingOrThrow(USER, true, 60))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("all 100 transcription minutes");
    }

    @Test
    @DisplayName("an import longer than what is left is refused before it is uploaded")
    void tooLongToFitIsRefused() {
        row.setAiMinutesUsed(95);

        // Ten minutes into a five-minute balance. Accepting it would transcribe
        // the whole thing and put the account 5 minutes over, which is a worse
        // way to find out.
        assertThatThrownBy(() -> service.chargeMeetingOrThrow(USER, false, 600))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("10 minutes and you have 5 left");
        assertThat(row.getImportsUsed()).isZero();
    }

    @Test
    @DisplayName("a file that fits is allowed, to the last minute")
    void exactFitIsAllowed() {
        row.setAiMinutesUsed(95);

        service.chargeMeetingOrThrow(USER, false, 300);

        assertThat(row.getImportsUsed()).isEqualTo(1);
    }

    @Test
    @DisplayName("a part-minute counts as a whole one")
    void partMinutesRoundUp() {
        row.setAiMinutesUsed(99);

        // 61 seconds is two minutes of a one-minute balance. Rounding down here
        // would let a file through that cannot finish inside the allowance.
        assertThatThrownBy(() -> service.chargeMeetingOrThrow(USER, false, 61))
                .isInstanceOf(ApiException.class);
    }

    @Test
    @DisplayName("a recording is never refused for its length, only for an empty balance")
    void recordingIsNotMeasuredAgainstTheBalance() {
        row.setAiMinutesUsed(95);

        // Half an hour into a five-minute balance. The meeting already happened
        // -- somebody sat through it -- and refusing it at save time destroys
        // the audio to defend the number. An import in the same position is
        // refused, because the file is still on their disk.
        service.chargeMeetingOrThrow(USER, true, 1800);

        assertThat(row.getMeetingsUsed()).isEqualTo(1);
        assertThatThrownBy(() -> service.chargeMeetingOrThrow(USER, false, 1800))
                .isInstanceOf(ApiException.class);
    }

    @Test
    @DisplayName("an unknown length is allowed while any balance is left")
    void unknownLengthIsAllowedOnBalance() {
        row.setAiMinutesUsed(99);

        // The client does not always know how long a file is. One minute left
        // is thin, but refusing on a length nobody stated would refuse a
        // ten-second voice note as readily as an hour of audio.
        service.chargeMeetingOrThrow(USER, true, null);

        assertThat(row.getMeetingsUsed()).isEqualTo(1);
    }

    @Test
    @DisplayName("minutes spent past the allowance are kept, not clamped")
    void overrunIsRecordedHonestly() {
        row.setAiMinutesUsed(95);

        service.addAiMinutes(USER, 20);

        // The transcript exists and was paid for. Refusing to record what it
        // cost would only hide the overrun from the next check.
        assertThat(row.getAiMinutesUsed()).isEqualTo(115);
    }

    @Test
    @DisplayName("usage reads as zero for an account that has never used anything")
    void emptyAccountReadsZero() {
        when(usage.findByUserId(USER)).thenReturn(Optional.empty());
        when(users.findById(USER)).thenReturn(Optional.empty());

        var response = service.getUsage(USER);

        assertThat(response.minutesUsed()).isZero();
        assertThat(response.minutesLimit()).isEqualTo(UsageLimitService.MINUTES_ALLOWANCE);
        assertThat(response.importsLimit()).isEqualTo(UsageLimitService.IMPORT_ALLOWANCE);
        // Reading usage must not create the row it reads.
        assertThat(response.plan()).isEqualTo("FREE");
    }
}
