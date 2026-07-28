package com.recallix.config;

import org.springframework.beans.BeansException;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.context.annotation.Configuration;
import org.springframework.lang.NonNull;

import javax.sql.DataSource;

/**
 * Wraps the auto-configured DataSource so every connection carries its tenant.
 *
 * <p>Done as a post-processor rather than by declaring a DataSource bean
 * outright, so Spring Boot still builds and configures HikariCP normally — the
 * pool keeps its own settings, health check and metrics, and only the handing
 * out of connections is intercepted.
 *
 * <p>Wrapping here also means Flyway gets the same wrapper. That is intended:
 * migrations then run with an explicit, visible tenant setting rather than
 * whatever the connection happened to hold. DDL is unaffected by row-level
 * security, but any future migration that moves data must set
 * {@code app.bypass} itself — noted at the top of V9.
 */
@Configuration
public class TenantDataSourceConfig implements BeanPostProcessor {

    @Override
    public Object postProcessAfterInitialization(@NonNull Object bean, @NonNull String beanName)
            throws BeansException {
        if (bean instanceof DataSource dataSource && !(bean instanceof TenantAwareDataSource)) {
            return new TenantAwareDataSource(dataSource);
        }
        return bean;
    }
}
