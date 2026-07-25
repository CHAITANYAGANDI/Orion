package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.entity.UserEntity;
import com.recallix.repository.UserRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Maps Clerk (or dev) identities to local user rows and provisions on first use. */
@Service
public class UserService {

    private final UserRepository users;

    public UserService(UserRepository users) {
        this.users = users;
    }

    /** Upsert a local user for the given Clerk (or dev) subject; returns local user id. */
    @Transactional
    public String provision(String clerkUserId, String email) {
        UserEntity user = users.findByClerkUserId(clerkUserId).orElseGet(() -> {
            UserEntity u = new UserEntity();
            u.setId(IdGenerator.user());
            u.setClerkUserId(clerkUserId);
            u.setEmail(email);
            u.setPlan("FREE");
            return users.save(u);
        });
        if (email != null && !email.equals(user.getEmail())) {
            user.setEmail(email);
        }
        return user.getId();
    }

    @Transactional(readOnly = true)
    public UserEntity require(String userId) {
        return users.findById(userId)
                .orElseThrow(() -> ApiException.unauthorized("Unknown user"));
    }

    @Transactional
    public void updatePlan(String userId, String plan) {
        UserEntity user = require(userId);
        user.setPlan(plan);
    }
}
