package com.recallix.config;

import com.recallix.security.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The point where row-level security is actually armed.
 *
 * <p>If this class fails to stamp a connection, the V9 policies still run — they
 * just evaluate against whatever the previous borrower left behind. That is the
 * one failure mode that turns a security feature into a cross-tenant leak, so
 * these tests are mostly about the settings being written unconditionally.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class TenantAwareDataSourceTest {

    @Mock private DataSource delegate;
    @Mock private Connection connection;
    @Mock private PreparedStatement statement;

    private TenantAwareDataSource dataSource;

    @BeforeEach
    void setUp() throws SQLException {
        when(delegate.getConnection()).thenReturn(connection);
        when(connection.prepareStatement(anyString())).thenReturn(statement);
        dataSource = new TenantAwareDataSource(delegate);
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @Test
    @DisplayName("the authenticated tenant is stamped on the connection")
    void stampsTheTenant() throws SQLException {
        TenantContext.setUserId("usr_alice");

        dataSource.getConnection();

        verify(statement).setString(1, "usr_alice");
        verify(statement).execute();
    }

    @Test
    @DisplayName("with no tenant the connection is stamped empty, not left alone")
    void stampsEmptyWhenThereIsNoTenant() throws SQLException {
        // The critical case. Skipping the write here would leave the previous
        // borrower's user id in place, and the next query would run as them.
        dataSource.getConnection();

        verify(statement).setString(1, "");
        verify(statement).execute();
    }

    @Test
    @DisplayName("no bypass is ever written — the exemption is the role, not a setting")
    void neverWritesABypassSetting() throws SQLException {
        // A settable exemption is one an injected statement could switch on.
        // System access now comes from connecting as a BYPASSRLS role instead,
        // so nothing here may reintroduce a flag.
        TenantContext.runAsSystem(() -> {
            try {
                dataSource.getConnection();
            } catch (SQLException e) {
                throw new IllegalStateException(e);
            }
        });

        verify(statement, never()).setString(eq(2), anyString());
    }

    @Test
    @DisplayName("every checkout is stamped, so a stale tenant cannot survive")
    void stampsOnEveryCheckout() throws SQLException {
        TenantContext.setUserId("usr_alice");
        dataSource.getConnection();

        TenantContext.setUserId("usr_bob");
        dataSource.getConnection();

        verify(statement).setString(1, "usr_alice");
        verify(statement).setString(1, "usr_bob");
        verify(statement, times(2)).execute();
    }

    @Test
    @DisplayName("the tenant is bound as a parameter, never concatenated")
    void tenantIsParameterised() throws SQLException {
        // This statement runs before every query in the application; building
        // it by string concatenation would be a poor place for an injection.
        TenantContext.setUserId("'; DROP TABLE meetings; --");

        dataSource.getConnection();

        verify(connection).prepareStatement(anyString());
        verify(statement).setString(1, "'; DROP TABLE meetings; --");
        verify(statement, never()).execute(anyString());
    }

    @Test
    @DisplayName("a connection that cannot be stamped is closed, not handed out")
    void unstampableConnectionIsClosed() throws SQLException {
        when(statement.execute()).thenThrow(new SQLException("connection reset"));

        assertThatThrownBy(() -> dataSource.getConnection()).isInstanceOf(SQLException.class);

        // It still carries the previous borrower's identity, so returning it to
        // the caller would serve this request with someone else's access.
        verify(connection).close();
    }

    @Test
    @DisplayName("the statement is closed even on the happy path")
    void statementIsClosed() throws SQLException {
        dataSource.getConnection();
        verify(statement).close();
    }

    @Test
    @DisplayName("the delegate's connection is what gets returned")
    void returnsTheUnderlyingConnection() throws SQLException {
        assertThat(dataSource.getConnection()).isSameAs(connection);
    }
}
