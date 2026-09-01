package com.reverie;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class ReverieApplication {
    public static void main(String[] args) {
        SpringApplication.run(ReverieApplication.class, args);
    }
}
