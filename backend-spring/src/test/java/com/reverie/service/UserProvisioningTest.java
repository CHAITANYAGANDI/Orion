package com.reverie.service;

import com.reverie.common.ApiException;
import com.reverie.entity.UserEntity;
import com.reverie.repository.UserRepository;
import com.reverie.security.SelfOnlyAccess;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
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
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * First login, several times at once.
 *
 * <h2>The bug this replaces</h2>
 *
 * <p>A browser opening the app fires several requests together, and on a
 * brand-new account every one of them authenticates a subject with no row yet.
 * {@code provision} read, found nothing, and inserted — so all of them read
 * nothing and all of them inserted. One won; the rest came back 500 against
 * {@code users_clerk_user_id_key}, which is how a real deployment produced four
 * of these in the same millisecond:
 *
 * <pre>
 * ERROR: duplicate key value violates unique constraint "users_clerk_user_id_key"
 *   Detail: Key (clerk_user_id)=(user_3IUiqZSNuF0gbjwWAMAs8eDkv9E) already exists.
 * </pre>
 *
 * <p>The account was created correctly — the constraint is what made sure of
 * that — but the user's first page load was mostly errors and a refresh cleared
 * it, which is the worst way for a bug to present: it looks like the product is
 * flaky rather than like anything is wrong.
 *
 * <h2>What these tests hold</h2>
 *
 * <p>That the decision moved into one Postgres statement, that the loser of the
 * race reads the winner's row instead of failing, and that the cheap path for
 * everybody who already exists did not get more expensive on the way.
 *
 * <p>The proof that it actually holds under real concurrency is
 * {@code UserProvisioningConcurrencyTest}, which needs a PostgreSQL. What is
 * checked here is the shape of the calls, which is the part a mock can see.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class UserProvisioningTest {

    private static final String SUBJECT = "user_3IUiqZSNuF0gbjwWAMAs8eDkv9E";
    private static final String EMAIL = "someone@example.com";

    @Mock private UserRepository users;

    private UserService service() {
        return new UserService(users, new SelfOnlyAccess(false, ""), "clerk");
    }

    private static UserEntity row(String id, String email) {
        UserEntity u = new UserEntity();
        u.setId(id);
        u.setClerkUserId(SUBJECT);
        u.setEmail(email);
        u.setPlan("FREE");
        return u;
    }

    @Nested
    @DisplayName("an account that already exists")
    class Existing {

        @Test
        @DisplayName("costs one lookup and no insert")
        void cheapPath() {
            /*
             * Every request after the first takes this path, so it is the one
             * that must not have got more expensive. One SELECT, no INSERT, no
             * second lookup.
             */
            when(users.findByClerkUserId(SUBJECT)).thenReturn(Optional.of(row("usr_1", EMAIL)));

            assertThat(service().provision(SUBJECT, EMAIL)).isEqualTo("usr_1");

            verify(users, times(1)).findByClerkUserId(SUBJECT);
            verify(users, never()).insertIfAbsent(anyString(), anyString(), anyString());
            verify(users, never()).save(any());
        }

        @Test
        @DisplayName("still has its address refreshed from the provider")
        void addressStillFollowsTheProvider() {
            // Unchanged behaviour, and worth pinning: under Clerk the column is
            // a cache of the provider's fact, so a changed address has to land.
            UserEntity existing = row("usr_1", "old@example.com");
            when(users.findByClerkUserId(SUBJECT)).thenReturn(Optional.of(existing));

            service().provision(SUBJECT, "new@example.com");

            assertThat(existing.getEmail()).isEqualTo("new@example.com");
        }

        @Test
        @DisplayName("keeps its address when the token carries none")
        void nullAddressLeavesItAlone() {
            UserEntity existing = row("usr_1", "kept@example.com");
            when(users.findByClerkUserId(SUBJECT)).thenReturn(Optional.of(existing));

            service().provision(SUBJECT, null);

            assertThat(existing.getEmail()).isEqualTo("kept@example.com");
        }
    }

    @Nested
    @DisplayName("an account that does not exist yet")
    class Creating {

        @Test
        @DisplayName("inserts once and returns the row it created")
        void winsTheRace() {
            when(users.findByClerkUserId(SUBJECT))
                    .thenReturn(Optional.empty())
                    .thenReturn(Optional.of(row("usr_new", EMAIL)));
            when(users.insertIfAbsent(anyString(), eq(SUBJECT), eq(EMAIL))).thenReturn(1);

            assertThat(service().provision(SUBJECT, EMAIL)).isEqualTo("usr_new");

            verify(users, times(1)).insertIfAbsent(anyString(), eq(SUBJECT), eq(EMAIL));
            verify(users, times(2)).findByClerkUserId(SUBJECT);
        }

        @Test
        @DisplayName("carries the address and the plan into the insert")
        void initialisationIsPreserved() {
            /*
             * The fields provision() used to set by hand. `plan` is passed
             * explicitly by the query; the rest of a new row -- created_at,
             * muted_notifications, speaker_learning_enabled and the five email
             * switches -- come from column defaults identical to the field
             * initialisers on UserEntity.
             */
            when(users.findByClerkUserId(SUBJECT))
                    .thenReturn(Optional.empty())
                    .thenReturn(Optional.of(row("usr_new", EMAIL)));

            service().provision(SUBJECT, EMAIL);

            verify(users).insertIfAbsent(anyString(), eq(SUBJECT), eq(EMAIL));
        }

        @Test
        @DisplayName("never calls save(), which is what used to lose the race")
        void noSave() {
            when(users.findByClerkUserId(SUBJECT))
                    .thenReturn(Optional.empty())
                    .thenReturn(Optional.of(row("usr_new", EMAIL)));

            service().provision(SUBJECT, EMAIL);

            verify(users, never()).save(any());
        }
    }

    @Nested
    @DisplayName("losing the race")
    class Losing {

        @Test
        @DisplayName("reads the winner's row rather than failing")
        void zeroRowsInsertedIsNotAnError() {
            /*
             * insertIfAbsent returning 0 is the whole point: somebody else got
             * there first, the conflict clause swallowed this insert, and the
             * row that exists is theirs. The old code raised
             * DataIntegrityViolationException here and the request 500'd.
             */
            when(users.findByClerkUserId(SUBJECT))
                    .thenReturn(Optional.empty())
                    .thenReturn(Optional.of(row("usr_winner", EMAIL)));
            when(users.insertIfAbsent(anyString(), eq(SUBJECT), eq(EMAIL))).thenReturn(0);

            assertThat(service().provision(SUBJECT, EMAIL)).isEqualTo("usr_winner");
        }

        @Test
        @DisplayName("returns the winner's id, not the one it generated")
        void theGeneratedIdIsDiscarded() {
            // Both callers generate a candidate id before they know who wins.
            // Only the winner's reaches the database, and both callers must
            // leave with that one -- otherwise the loser hands its own id to a
            // request that then acts as a user who does not exist.
            when(users.findByClerkUserId(SUBJECT))
                    .thenReturn(Optional.empty())
                    .thenReturn(Optional.of(row("usr_winner", EMAIL)));
            when(users.insertIfAbsent(anyString(), eq(SUBJECT), eq(EMAIL))).thenReturn(0);

            assertThat(service().provision(SUBJECT, EMAIL)).isEqualTo("usr_winner");
        }
    }

    @Nested
    @DisplayName("self-only mode")
    class SelfOnly {

        @Test
        @DisplayName("refuses before any lookup or insert")
        void nothingIsTouched() {
            /*
             * The gate runs first, and "first" now has to mean before the
             * insert as well as before the lookup. A refused subject that
             * reached insertIfAbsent would get a real row with a real id --
             * exactly the thing SelfOnlyAccess exists to prevent, arrived at
             * through a different door.
             */
            UserService gated = new UserService(
                    users, new SelfOnlyAccess(true, "user_2someoneElse"), "clerk");

            assertThatThrownBy(() -> gated.provision(SUBJECT, EMAIL))
                    .isInstanceOf(ApiException.class);

            verifyNoInteractions(users);
        }
    }
}
