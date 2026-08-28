package com.orion.config;

import com.orion.security.TenantContext;
import org.springframework.jdbc.datasource.DelegatingDataSource;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;

/**
 * Stamps the current tenant onto every connection handed out of the pool.
 *
 * <p>This is where row-level security is actually armed: the V9 policies test
 * {@code app.user_id} and {@code app.bypass}, and this class is what puts them
 * there.
 *
 * <p><b>The settings are written on every single checkout, without exception.</b>
 * That is the whole design. A pooled connection outlives the request that used
 * it, so anything left behind is inherited by the next borrower — and the next
 * borrower is usually a different user. Setting the values unconditionally
 * means a stale tenant cannot survive, because the very next checkout
 * overwrites it. Skipping the write when there is no tenant would be the bug:
 * the connection would silently retain whoever held it last.
 *
 * <p>Session-level {@code set_config} is used rather than {@code SET LOCAL}
 * because connections are borrowed outside an explicit transaction as well as
 * inside one, and a transaction-scoped setting would evaporate before the
 * statement that needs it.
 */
public class TenantAwareDataSource extends DelegatingDataSource {

    /**
     * One round trip, parameterised. String-concatenating a user id into SQL
     * executed before every query would be a poor place to introduce an
     * injection point.
     *
     * <p>Only the tenant is set. The system exemption used to be a second
     * setting here, but a setting can be changed by any statement, so it is now
     * carried by the connection's role instead — see
     * {@link TenantRoutingDataSource}.
     */
    private static final String APPLY_TENANT = "SELECT set_config('app.user_id', ?, false)";

    public TenantAwareDataSource(DataSource target) {
        super(target);
    }

    @Override
    public Connection getConnection() throws SQLException {
        return apply(super.getConnection());
    }

    @Override
    public Connection getConnection(String username, String password) throws SQLException {
        return apply(super.getConnection(username, password));
    }

    private static Connection apply(Connection connection) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(APPLY_TENANT)) {
            statement.setString(1, TenantContext.currentUserId());
            statement.execute();
        } catch (SQLException e) {
            // A connection whose tenant could not be set is not safe to use: it
            // still carries the previous borrower's identity. Return it to the
            // pool and fail rather than serve a request with someone else's
            // access.
            try {
                connection.close();
            } catch (SQLException ignored) {
                // The original failure is the one worth reporting.
            }
            throw e;
        }
        return connection;
    }
}
