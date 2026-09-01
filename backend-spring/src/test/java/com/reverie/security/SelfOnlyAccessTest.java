package com.reverie.security;

import com.reverie.common.ApiException;
import com.reverie.entity.UserEntity;
import com.reverie.repository.UserRepository;
import com.reverie.service.UserService;
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
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * One account, and the proof that it is enforced rather than promised.
 *
 * <h2>What was wrong with the version this replaces</h2>
 *
 * <p>{@code REVERIE_MAIL_SELF_ONLY} was a declaration: "this deployment has no
 * users other than me", made so a solo deployment with no mail domain could
 * pass the production check honestly instead of having the check deleted. It
 * was load-bearing — it is what made Resend's shared sender acceptable, since
 * that sender delivers only to the operator — and nothing made it true. A
 * stranger reaching Clerk's hosted sign-up got a valid token, and Reverie
 * provisioned them an account on their first request. The deployment check was
 * then relying on a fact that had quietly stopped holding.
 *
 * <h2>And the second thing that was wrong with it</h2>
 *
 * <p>A blank {@code REVERIE_MAIL_SELF_USER_ID} used to mean "enforce nothing",
 * on the reasoning that an empty allow-list refusing everybody would lock an
 * operator out over a missing variable. That made the one setting whose job is
 * to restrict access silently do the opposite of what it said: a typo in the
 * second variable name produced an <em>open</em> deployment where every signal
 * agreed it was closed. It now fails closed, at startup.
 *
 * <h2>Where the gate has to be</h2>
 *
 * <p>Not the sign-up page. Clerk creates the account whatever Reverie's UI shows,
 * and the token it mints is real. The only thing that cannot be walked around
 * is the moment Reverie decides a subject deserves a row, and that is
 * {@link UserService#provision} — which is also the only place that can refuse
 * <em>without leaving one behind</em>.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class SelfOnlyAccessTest {

    private static final String ME = "user_2abcMineOwnAccount";
    private static final String SOMEBODY_ELSE = "user_2xyzNotMine";

    @Mock private UserRepository users;

    private UserService serviceWith(SelfOnlyAccess gate) {
        return new UserService(users, gate, "clerk");
    }

    private static SelfOnlyAccess enforcing() {
        return new SelfOnlyAccess(true, ME);
    }

    private static SelfOnlyAccess open() {
        return new SelfOnlyAccess(false, "");
    }

    @Nested
    @DisplayName("the gate itself")
    class Gate {

        @Test
        @DisplayName("lets everybody through when it is off")
        void offByDefault() {
            SelfOnlyAccess gate = open();

            assertThat(gate.enforced()).isFalse();
            assertThat(gate.permits(SOMEBODY_ELSE)).isTrue();
            assertThat(gate.permits(null)).isTrue();
        }

        @Test
        @DisplayName("cannot be constructed at all when it was switched on without an account")
        void failsClosed() {
            /*
             * The correction. This used to enforce nothing, which made the one
             * setting whose job is to restrict access silently do the opposite
             * of what it says -- and a typo in the second variable name is all
             * it takes to get there.
             *
             * Refusing to construct fails application startup with the reason
             * on it. An unstartable deployment is a bad ten minutes; an open one
             * that believes it is closed is what this class exists to prevent.
             */
            assertThatThrownBy(() -> new SelfOnlyAccess(true, ""))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("REVERIE_MAIL_SELF_USER_ID")
                    .hasMessageContaining("refuses to start");
        }

        @Test
        @DisplayName("treats whitespace as blank, since a pasted variable can be either")
        void whitespaceIsBlank() {
            for (String nothing : new String[]{"", "   ", "\t", null}) {
                assertThatThrownBy(() -> new SelfOnlyAccess(true, nothing))
                        .as(String.valueOf(nothing))
                        .isInstanceOf(IllegalStateException.class);
            }
        }

        @Test
        @DisplayName("says how to get out of it, both ways")
        void theMessageIsActionable() {
            // Somebody reading this is either missing an id or did not want the
            // restriction at all, and the message has to serve both.
            assertThatThrownBy(() -> new SelfOnlyAccess(true, ""))
                    .hasMessageContaining("user_")
                    .hasMessageContaining("Clerk dashboard")
                    .hasMessageContaining("unset REVERIE_MAIL_SELF_ONLY");
        }

        @Test
        @DisplayName("a blank id is fine while self-only is off, which is every laptop")
        void blankIsFineWhenOff() {
            /*
             * Local development needs no configuration and gets no exception:
             * the flag is unset by default, which asks for no restriction and
             * gets none. The failure above is reachable only by asking for a
             * restriction and then not saying what it is.
             */
            SelfOnlyAccess gate = new SelfOnlyAccess(false, "");

            assertThat(gate.enforced()).isFalse();
            assertThat(gate.permits(SOMEBODY_ELSE)).isTrue();
            assertThat(gate.permits(null)).isTrue();
        }

        @Test
        @DisplayName("enforced() is the flag, because the other state cannot exist")
        void enforcedIsTheFlag() {
            // The invariant the constructor buys: a live instance with enforced
            // true always has an account to compare against.
            assertThat(new SelfOnlyAccess(true, ME).enforced()).isTrue();
            assertThat(new SelfOnlyAccess(false, ME).enforced()).isFalse();
        }

        @Test
        @DisplayName("admits the one account and refuses every other")
        void oneAccount() {
            SelfOnlyAccess gate = enforcing();

            assertThat(gate.enforced()).isTrue();
            assertThat(gate.permits(ME)).isTrue();
            assertThat(gate.permits(SOMEBODY_ELSE)).isFalse();
            assertThat(gate.permits("")).isFalse();
            assertThat(gate.permits(null)).isFalse();
        }

        @Test
        @DisplayName("ignores whitespace around a pasted id")
        void trimmed() {
            // It is copied out of the Clerk dashboard and pasted into Render.
            assertThat(new SelfOnlyAccess(true, "  " + ME + "  ").permits(ME)).isTrue();
            assertThat(enforcing().permits(" " + ME + " ")).isTrue();
        }

        @Test
        @DisplayName("refuses with 403, not 401")
        void forbiddenNotUnauthorized() {
            // They proved who they are perfectly well. Calling the token invalid
            // would send them round a sign-in loop that can never succeed.
            assertThatThrownBy(() -> enforcing().requireOrThrow(SOMEBODY_ELSE))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("private");
        }
    }

    @Nested
    @DisplayName("provisioning")
    class Provisioning {

        @Test
        @DisplayName("the self account can use Reverie")
        void selfIsLetIn() {
            UserEntity mine = new UserEntity();
            mine.setId("usr_1");
            mine.setClerkUserId(ME);
            when(users.findByClerkUserId(ME)).thenReturn(Optional.of(mine));

            assertThat(serviceWith(enforcing()).provision(ME, "me@example.com")).isEqualTo("usr_1");
        }

        @Test
        @DisplayName("the self account is created on its first request, like any other")
        void selfIsProvisioned() {
            when(users.findByClerkUserId(ME)).thenReturn(Optional.empty());
            when(users.save(any())).thenAnswer(i -> i.getArgument(0));

            assertThat(serviceWith(enforcing()).provision(ME, "me@example.com")).isNotBlank();
            verify(users).save(any());
        }

        @Test
        @DisplayName("a second Clerk account is rejected")
        void strangerIsRefused() {
            assertThatThrownBy(() ->
                    serviceWith(enforcing()).provision(SOMEBODY_ELSE, "them@example.com"))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("a second Clerk account is never inserted")
        void strangerLeavesNothingBehind() {
            /*
             * The half that is easy to get wrong. Refusing the request but
             * inserting the row would leave a real account with a real id
             * behind -- one that every later request could act as, and one
             * somebody has to find and delete. The gate runs before the lookup
             * for exactly this reason.
             */
            assertThatThrownBy(() ->
                    serviceWith(enforcing()).provision(SOMEBODY_ELSE, "them@example.com"))
                    .isInstanceOf(ApiException.class);

            verify(users, never()).save(any());
            verifyNoInteractions(users);
        }

        @Test
        @DisplayName("nothing changes when the gate is off")
        void openDeploymentIsUnaffected() {
            // The ordinary production path. Any subject provisions, as before.
            when(users.findByClerkUserId(SOMEBODY_ELSE)).thenReturn(Optional.empty());
            when(users.save(any())).thenAnswer(i -> i.getArgument(0));

            assertThat(serviceWith(open()).provision(SOMEBODY_ELSE, "them@example.com"))
                    .isNotBlank();
            verify(users).save(any());
        }

        @Test
        @DisplayName("there is no half-configured gate to provision through")
        void noHalfConfiguredGate() {
            // The state this used to have a test for cannot be reached: the
            // gate that would have let everybody through no longer constructs.
            assertThatThrownBy(() -> serviceWith(new SelfOnlyAccess(true, "")))
                    .isInstanceOf(IllegalStateException.class);
        }
    }
}
