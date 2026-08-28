package com.orion.common;

import java.util.List;
import java.util.regex.Pattern;

/**
 * Names a chat thread after the question that started it.
 *
 * <p><b>Why this is not a model call.</b> A generated title would read better —
 * "Action Items, Last Week" rather than "Action items from last week" — but it
 * would have to happen on the first message of every new conversation, which is
 * the single worst place in the product to add a second of latency and a
 * failure mode. The user is waiting on an answer, not on a label for a list
 * they are not looking at. This is instant, free, deterministic, and wrong in
 * ways that are obvious rather than surprising; renaming covers the rest.
 *
 * <p>The transformation is deliberately timid. Stripping "what are the" off the
 * front of a question is safe and makes a list scannable; anything cleverer
 * risks turning a question into a statement that means something different from
 * what was asked.
 */
public final class ConversationTitle {

    /** Long enough to disambiguate two similar questions, short enough for a menu row. */
    static final int MAX_LENGTH = 60;

    /** Shown when a conversation has no question in it yet. */
    public static final String UNTITLED = "New chat";

    /**
     * Openers that carry no information about the subject.
     *
     * <p>Ordered longest-first so "what are the" is tried before "what are";
     * the first match wins, and a shorter prefix matching first would leave
     * "the" stranded at the front of the title.
     */
    private static final List<String> OPENERS = List.of(
            "can you tell me about", "can you tell me", "could you tell me",
            "tell me about", "tell me", "can you give me", "could you give me",
            "give me a list of", "give me the", "give me",
            "i want to know about", "i want to know", "i'd like to know",
            "what are all the", "what are all", "what are the", "what are",
            "what is the", "what is", "what's the", "what's",
            "who are the", "who are", "who is the", "who is", "who's",
            "when is the", "when is", "when are", "when did", "when do",
            "where is the", "where is", "where are",
            "which of the", "which are the", "which is the", "which",
            "how many of the", "how many", "how much", "how do i", "how do we", "how does",
            "why did we", "why did", "why is", "why are",
            "show me all the", "show me all", "show me the", "show me",
            "list all of the", "list all the", "list all", "list the", "list",
            "find all the", "find all", "find me", "find",
            "summarize the", "summarise the", "summarize", "summarise",
            "did we", "did i", "do we", "do i", "was there", "were there",
            "please"
    );

    /**
     * Words that cannot start a title.
     *
     * <p>Stripping an opener sometimes exposes a preposition or a pronoun —
     * "Which of these is blocking?" becomes "of these is blocking" — which is
     * not a shorter title, it is a broken sentence. When the remainder starts
     * with one of these the question is left alone.
     */
    private static final List<String> FRAGMENT_STARTERS = List.of(
            "of", "to", "in", "on", "at", "for", "with", "from", "by", "about",
            "that", "this", "these", "those", "it", "them", "and", "or", "but"
    );

    private static final Pattern WHITESPACE = Pattern.compile("\\s+");
    /** Trailing punctuation a question ends with but a title should not. */
    private static final Pattern TRAILING = Pattern.compile("[\\s?!.,;:]+$");

    private ConversationTitle() {
    }

    /**
     * @param question the first thing asked in the conversation
     * @return a title, never blank
     */
    public static String from(String question) {
        if (question == null) {
            return UNTITLED;
        }
        String text = WHITESPACE.matcher(question.trim()).replaceAll(" ");
        text = TRAILING.matcher(text).replaceAll("");
        if (text.isEmpty()) {
            return UNTITLED;
        }

        text = stripOpener(text);
        text = truncate(text);
        if (text.isEmpty()) {
            return UNTITLED;
        }
        return Character.toUpperCase(text.charAt(0)) + text.substring(1);
    }

    /**
     * Remove a leading interrogative, but only when something substantial is
     * left. "What is it?" stripped to "it" is a worse title than the question.
     */
    private static String stripOpener(String text) {
        String lower = text.toLowerCase();
        for (String opener : OPENERS) {
            if (!lower.startsWith(opener + " ")) {
                continue;
            }
            String rest = text.substring(opener.length()).trim();
            // Two characters is a stub, not a subject.
            if (rest.length() <= 2 || startsWithFragment(rest)) {
                return text;
            }
            return rest;
        }
        return text;
    }

    private static boolean startsWithFragment(String text) {
        int space = text.indexOf(' ');
        String first = (space < 0 ? text : text.substring(0, space)).toLowerCase();
        return FRAGMENT_STARTERS.contains(first);
    }

    /** Cut on a word boundary — a title ending mid-word reads as corrupted. */
    private static String truncate(String text) {
        if (text.length() <= MAX_LENGTH) {
            return text;
        }
        String cut = text.substring(0, MAX_LENGTH);
        int lastSpace = cut.lastIndexOf(' ');
        // Only honour the boundary if it leaves most of the budget used;
        // otherwise a single long word would collapse the title to nothing.
        if (lastSpace > MAX_LENGTH / 2) {
            cut = cut.substring(0, lastSpace);
        }
        return TRAILING.matcher(cut).replaceAll("") + "…";
    }
}
