package com.recallix;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class RecallixApplication {
    public static void main(String[] args) {
        SpringApplication.run(RecallixApplication.class, args);
    }
}
