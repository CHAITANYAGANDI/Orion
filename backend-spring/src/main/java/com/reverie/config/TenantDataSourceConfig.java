package com.reverie.config;

import com.zaxxer.hikari.HikariDataSource;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.boot.jdbc.DataSourceBuilder;

import javax.sql.DataSource;
import java.util.Map;

/**
 * Two connection pools, two database roles, one routing DataSource.
 *
 * <ul>
 *   <li><b>tenant</b> — {@code reverie_app}, no BYPASSRLS. Serves every user
 *       request, and row-level security applies to it.</li>
 *   <li><b>system</b> — {@code reverie_sys}, BYPASSRLS. Serves only the paths
 *       with no user behind them: worker callbacks, the outbox relay, Stripe
 *       and user provisioning.</li>
 * </ul>
 *
 * <p>Splitting by role rather than by a session setting is the whole point. A
 * setting can be changed by any statement, so the previous design let SQL
 * injection escape tenant isolation entirely. A role attribute cannot be
 * granted by a statement.
 *
 * <p>Both pools are wrapped in {@link TenantAwareDataSource} so the tenant is
 * stamped on checkout either way — the system pool ignores it, but stamping
 * unconditionally keeps the two paths identical and leaves nothing stale.
 *
 * <p>Migrations are unaffected: Flyway has its own url/user/password
 * (application.yml) and connects as the schema owner.
 */
@Configuration
public class TenantDataSourceConfig {

    /**
     * Sized well below the tenant pool: system work is a trickle (one outbox
     * tick a second, occasional callbacks) and each connection here is
     * privileged, so there is no reason to keep many around.
     */
    private static final int SYSTEM_POOL_MAX = 5;

    /**
     * Both pools are built the same explicit way. Binding {@code spring.datasource}
     * straight onto a {@link HikariDataSource} does not work: Hikari spells the
     * property {@code jdbcUrl}, so {@code spring.datasource.url} silently does not
     * bind and the pool comes up with a driver and no URL.
     */
    @Bean
    DataSource tenantDataSource(
            @Value("${spring.datasource.url}") String url,
            @Value("${spring.datasource.username}") String username,
            @Value("${spring.datasource.password}") String password) {
        HikariDataSource ds = pool(url, username, password);
        ds.setPoolName("reverie-tenant");
        return ds;
    }

    @Bean
    DataSource systemDataSource(
            @Value("${spring.datasource.url}") String url,
            @Value("${reverie.datasource.system.username:reverie_sys}") String username,
            @Value("${reverie.datasource.system.password:reverie_sys}") String password) {
        HikariDataSource ds = pool(url, username, password);
        ds.setMaximumPoolSize(SYSTEM_POOL_MAX);
        ds.setPoolName("reverie-system");
        return ds;
    }

    private static HikariDataSource pool(String url, String username, String password) {
        return DataSourceBuilder.create()
                .type(HikariDataSource.class)
                .url(url)
                .username(username)
                .password(password)
                .build();
    }

    @Bean
    @Primary
    DataSource routingDataSource(DataSource tenantDataSource, DataSource systemDataSource) {
        TenantRoutingDataSource routing = new TenantRoutingDataSource();
        routing.setTargetDataSources(Map.of(
                TenantRoutingDataSource.Route.TENANT, new TenantAwareDataSource(tenantDataSource),
                TenantRoutingDataSource.Route.SYSTEM, new TenantAwareDataSource(systemDataSource)));
        // Anything that fails to declare itself gets the restricted pool and
        // reads nothing, rather than silently getting the privileged one.
        routing.setDefaultTargetDataSource(new TenantAwareDataSource(tenantDataSource));
        return routing;
    }
}
