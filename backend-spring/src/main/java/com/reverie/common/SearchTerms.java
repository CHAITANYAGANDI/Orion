package com.reverie.common;

import java.util.ArrayList;
import java.util.List;

/**
 * Turns what someone typed into the two shapes the search queries need.
 *
 * <p><b>Why the query is built here and not in SQL.</b> Postgres has three
 * functions that parse user text into a {@code tsquery} — {@code plainto_},
 * {@code phraseto_} and {@code websearch_to_tsquery} — and all three are
 * injection-safe, which is the usual reason to prefer them. None of them can
 * produce a prefix match. This box is typed into a character at a time, so
 * "stri" has to find "Stripe" or the results only appear once the word is
 * finished; that requires {@code to_tsquery} with an explicit {@code :*}, and
 * {@code to_tsquery} <em>does</em> parse its argument as query syntax. A stray
 * apostrophe would be a syntax error and a stray {@code !} would silently invert
 * the search.
 *
 * <p>So the sanitising happens here, by construction rather than by escaping:
 * everything that is not a letter or a digit is a separator, and the tokens are
 * reassembled with operators this code chose. There is no input that can reach
 * {@code to_tsquery} as an operator, because no operator survives tokenising.
 *
 * <p>The same argument applies to {@code LIKE}: {@code %} and {@code _} in a
 * search term are wildcards, so a user searching for "50%" would match every
 * row. Those are escaped rather than dropped, since unlike query operators they
 * are characters someone might genuinely be looking for.
 */
public final class SearchTerms {

    /**
     * Terms past this point stop narrowing anything.
     *
     * <p>Each one is another AND against the index, and a search with nine words
     * in it is a sentence rather than a query — it will match nothing whether or
     * not the tail is included, so the tail is dropped and the cost bounded.
     */
    private static final int MAX_TERMS = 8;

    /** Escape character for {@code LIKE}, matching the {@code ESCAPE} clause in the queries. */
    private static final char LIKE_ESCAPE = '\\';

    private SearchTerms() {
    }

    /**
     * A {@code to_tsquery('simple', ...)} argument, or {@code ""} when there is
     * nothing to search for.
     *
     * <p>Terms are ANDed, so "stripe invoice" finds utterances containing both
     * rather than either — with one search box and no operators, a second word
     * is nearly always an attempt to narrow the first. Only the last term is a
     * prefix: the earlier ones are finished words, and treating "the" in "the
     * stripe migration" as {@code the:*} would match every "there" and "their"
     * in the archive.
     *
     * <p>The empty string is a legitimate result and callers must treat it as
     * "no text search", not as a query that matches nothing — {@code to_tsquery}
     * rejects it outright.
     */
    public static String toTsQuery(String raw) {
        List<String> terms = tokenize(raw);
        if (terms.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < terms.size(); i++) {
            if (i > 0) {
                sb.append(" & ");
            }
            sb.append(terms.get(i));
            if (i == terms.size() - 1) {
                sb.append(":*");
            }
        }
        return sb.toString();
    }

    /**
     * A {@code %term%} pattern for the short-text columns — titles, decisions,
     * commitments, speaker names — or {@code ""} when there is nothing to match.
     *
     * <p>These stay on {@code ILIKE} rather than joining the full-text index on
     * purpose. A decision is one sentence and a title is a few words, so
     * substring matching is both affordable and better: "auth" finds
     * "reauthenticate", which a word-boundary index never would, and on text
     * this short the difference is the whole point of typing three letters.
     */
    public static String toLike(String raw) {
        String trimmed = raw == null ? "" : raw.trim();
        if (trimmed.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder("%");
        for (char c : trimmed.toCharArray()) {
            if (c == '%' || c == '_' || c == LIKE_ESCAPE) {
                sb.append(LIKE_ESCAPE);
            }
            sb.append(c);
        }
        return sb.append('%').toString();
    }

    /**
     * Splits on everything that is not alphanumeric.
     *
     * <p>{@link Character#isLetterOrDigit} rather than {@code [a-z0-9]}: the
     * archive is multilingual, and an ASCII class would reduce a Hindi or German
     * query to nothing at all.
     */
    private static List<String> tokenize(String raw) {
        List<String> out = new ArrayList<>();
        if (raw == null) {
            return out;
        }
        StringBuilder current = new StringBuilder();
        for (char c : raw.toCharArray()) {
            if (Character.isLetterOrDigit(c)) {
                current.append(c);
            } else if (current.length() > 0) {
                out.add(current.toString());
                current.setLength(0);
                if (out.size() == MAX_TERMS) {
                    return out;
                }
            }
        }
        if (current.length() > 0 && out.size() < MAX_TERMS) {
            out.add(current.toString());
        }
        return out;
    }
}
