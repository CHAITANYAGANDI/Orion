package com.orion;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.type.filter.AnnotationTypeFilter;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Controller;
import org.springframework.stereotype.Repository;
import org.springframework.stereotype.Service;
import org.springframework.context.annotation.Configuration;

import java.lang.reflect.Constructor;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Can Spring build these beans at all?
 *
 * <p>Written because of a bug that got all the way to a running container with a
 * green test suite behind it. {@code OutboxPublisher} was given a second
 * constructor so a test could fix its clock, which is a perfectly ordinary thing
 * to do — except that Spring only infers constructor injection when there is
 * exactly one candidate. With two and neither annotated it looked for a no-arg
 * constructor, found none, and the application failed to start:
 *
 * <pre>
 *   BeanInstantiationException: Failed to instantiate [OutboxPublisher]:
 *       No default constructor found
 * </pre>
 *
 * <p>Every unit test passed throughout, because every unit test calls
 * {@code new OutboxPublisher(...)} and picks a constructor itself. Nothing in
 * the suite asked the question Spring asks.
 *
 * <p>This test asks it, for every component in the application, without needing
 * a database, a broker or an object store. It is not a substitute for starting
 * the context — see {@code ApplicationContextSmokeTest} for that — but it is the
 * half that can run everywhere, in under a second, on every build.
 *
 * <h2>What it proves</h2>
 *
 * <p>That Spring has an unambiguous way to instantiate every bean it will be
 * asked to create: exactly one constructor, or several with exactly one marked
 * {@code @Autowired}, or a usable no-arg one. That is precisely the defect
 * above, and it generalises — the same mistake is one refactor away in any of
 * these classes.
 *
 * <h2>What it does not prove</h2>
 *
 * <p>Nothing about whether the dependencies those constructors ask for actually
 * exist, whether configuration binds, or whether the schema matches the
 * entities. Those need a context.
 */
class ApplicationWiringTest {

    private static final String BASE = "com.orion";

    /** Every class in the application Spring will instantiate as a bean. */
    private static Set<Class<?>> components() {
        ClassPathScanningCandidateComponentProvider scanner =
                new ClassPathScanningCandidateComponentProvider(false);
        for (Class<? extends java.lang.annotation.Annotation> stereotype :
                List.of(Component.class, Service.class, Repository.class,
                        Controller.class, Configuration.class)) {
            scanner.addIncludeFilter(new AnnotationTypeFilter(stereotype));
        }
        return scanner.findCandidateComponents(BASE).stream()
                .map(definition -> {
                    try {
                        return Class.forName(definition.getBeanClassName());
                    } catch (ClassNotFoundException e) {
                        throw new IllegalStateException(e);
                    }
                })
                // Interfaces are Spring Data repositories: Spring builds proxies
                // for those and there is no constructor to argue about.
                .filter(type -> !type.isInterface())
                .collect(Collectors.toSet());
    }

    @Test
    @DisplayName("the scan finds the application, so the rest of this test means something")
    void theScanIsNotEmpty() {
        // A test that silently passes over zero classes is worse than no test.
        assertThat(components())
                .hasSizeGreaterThan(40)
                .anyMatch(c -> c.getSimpleName().equals("OutboxPublisher"));
    }

    @Test
    @DisplayName("every bean has exactly one way for Spring to construct it")
    void constructorsAreUnambiguous() {
        List<String> ambiguous = new ArrayList<>();

        for (Class<?> type : components()) {
            Constructor<?>[] all = type.getDeclaredConstructors();
            if (all.length <= 1) {
                continue;
            }
            long annotated = Arrays.stream(all)
                    .filter(c -> c.isAnnotationPresent(Autowired.class))
                    .count();
            boolean hasNoArg = Arrays.stream(all)
                    .anyMatch(c -> c.getParameterCount() == 0 && !Modifier.isPrivate(c.getModifiers()));

            // Spring's rule, in one line: one annotated constructor wins; with
            // none, a single candidate wins; with none and several candidates it
            // falls back to a no-arg constructor and fails if there isn't one.
            if (annotated == 0 && !hasNoArg) {
                ambiguous.add(type.getName() + " has " + all.length
                        + " constructors, none annotated @Autowired, and no no-arg constructor");
            }
            if (annotated > 1) {
                ambiguous.add(type.getName() + " has " + annotated
                        + " constructors annotated @Autowired; Spring accepts at most one");
            }
        }

        assertThat(ambiguous)
                .as("Spring cannot choose a constructor for these, and will fail at startup")
                .isEmpty();
    }
}
