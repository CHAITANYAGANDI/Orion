package com.orion;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class OrionApplication {
    public static void main(String[] args) {
        SpringApplication.run(OrionApplication.class, args);
    }
}
