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
 *
 * <p><b>Which is why the runtime must not reach Postgres through a
 * transaction-mode pooler.</b> The setting above belongs to the session, and a
 * pooler in transaction mode does not keep sessions: it assigns a server
 * connection per transaction, so the {@code set_config} lands on one backend
 * and the query that follows can be given another, where {@code app.user_id}
 * was never set. Every policy then matches nothing — which is not an error
 * anywhere in this application. It is a 200 with an empty list and an ordinary
 * 404: an intact account that reads as "No conversations", an empty folder
 * rail, a meeting that cannot be found, a transcript that is unavailable, each
 * of them intermittently, per request. The same mechanism runs the other way,
 * handing a backend that still carries a previous borrower's tenant to whoever
 * asks next.
 *
 * <p>This is enforced rather than documented: {@link DeploymentCheck} refuses
 * to start a production deployment whose datasource URL names a pooler. If the
 * pooler is ever genuinely wanted, the tenant has to be set <em>inside</em>
 * each transaction instead — and this class is the wrong shape for that, since
 * checkout is not where the transaction begins.
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
