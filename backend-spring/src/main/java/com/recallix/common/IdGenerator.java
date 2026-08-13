package com.recallix.common;

import java.security.SecureRandom;

/**
 * Generates prefixed text primary keys in the application layer
 * (e.g. mtg_, usr_, ai_, dec_, rsk_, sub_, aud_) as required by the schema.
 */
public final class IdGenerator {

    private static final char[] ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int RANDOM_LEN = 20;

    private IdGenerator() {
    }

    public static String generate(String prefix) {
        StringBuilder sb = new StringBuilder(prefix.length() + RANDOM_LEN);
        sb.append(prefix);
        for (int i = 0; i < RANDOM_LEN; i++) {
            sb.append(ALPHABET[RANDOM.nextInt(ALPHABET.length)]);
        }
        return sb.toString();
    }

    public static String user()        { return generate("usr_"); }
    public static String meeting()     { return generate("mtg_"); }
    public static String transcript()  { return generate("txr_"); }
    public static String segment()     { return generate("seg_"); }
    public static String summary()     { return generate("sum_"); }
    public static String actionItem()  { return generate("ai_"); }
    public static String usage()       { return generate("usg_"); }
    public static String subscription(){ return generate("sub_"); }
    public static String audit()       { return generate("aud_"); }
    public static String outbox()      { return generate("obx_"); }
    public static String connection()  { return generate("con_"); }
    public static String agentAction() { return generate("aar_"); }
    public static String syncLog()     { return generate("syn_"); }
    public static String vocabulary()  { return generate("voc_"); }
    public static String knownSpeaker(){ return generate("spk_"); }
}
