package com.recallix.domain;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * The languages Recallix works in.
 *
 * <p>One list, used for two different things, and it is worth being explicit
 * about why they are the same list when they need not be.
 *
 * <p><strong>Input audio</strong> is genuinely limited to these. Transcription
 * runs on AssemblyAI's Universal-3.5 Pro, which supports eighteen spoken
 * languages; a meeting held in Telugu is not transcribable at all, and no
 * amount of translation downstream fixes that, because there is nothing to
 * translate. That is a hard boundary of the product and this enum is where it
 * is written down.
 *
 * <p><strong>Translation targets</strong> are not so limited — the translation
 * side supports a hundred-odd languages, so an English meeting could in
 * principle be read in Telugu even though a Telugu meeting cannot be
 * transcribed. Offering that asymmetry today would mean a picker with two very
 * different lists in it and a rule nobody can hold in their head, so for now the
 * target list is the same eighteen. Widening it later is adding entries here and
 * a flag to say which side they belong to; nothing else changes.
 *
 * <p>{@code nativeName} is the endonym, shown beside the English name in the
 * picker: somebody looking for their own language scans for "日本語" faster than
 * for "Japanese". {@code rightToLeft} is not decoration — Arabic and Hebrew
 * rendered left-to-right are not merely ugly, they are hard to read, and the
 * translated panes have to set {@code dir} from something.
 */
public enum Language {

    ENGLISH("en", "English", "English", false),
    SPANISH("es", "Spanish", "Español", false),
    GERMAN("de", "German", "Deutsch", false),
    FRENCH("fr", "French", "Français", false),
    PORTUGUESE("pt", "Portuguese", "Português", false),
    ITALIAN("it", "Italian", "Italiano", false),
    TURKISH("tr", "Turkish", "Türkçe", false),
    DUTCH("nl", "Dutch", "Nederlands", false),
    SWEDISH("sv", "Swedish", "Svenska", false),
    NORWEGIAN("no", "Norwegian", "Norsk", false),
    DANISH("da", "Danish", "Dansk", false),
    FINNISH("fi", "Finnish", "Suomi", false),
    HINDI("hi", "Hindi", "हिन्दी", false),
    VIETNAMESE("vi", "Vietnamese", "Tiếng Việt", false),
    ARABIC("ar", "Arabic", "العربية", true),
    HEBREW("he", "Hebrew", "עברית", true),
    JAPANESE("ja", "Japanese", "日本語", false),
    CHINESE("zh", "Chinese", "中文", false);

    private final String code;
    private final String englishName;
    private final String nativeName;
    private final boolean rightToLeft;

    Language(String code, String englishName, String nativeName, boolean rightToLeft) {
        this.code = code;
        this.englishName = englishName;
        this.nativeName = nativeName;
        this.rightToLeft = rightToLeft;
    }

    public String code() { return code; }
    public String englishName() { return englishName; }
    public String nativeName() { return nativeName; }
    public boolean rightToLeft() { return rightToLeft; }

    public static List<Language> all() {
        return List.of(values());
    }

    /**
     * Resolve whatever the caller sent.
     *
     * <p>Accepts the ISO code, the English name and the endonym, and tolerates
     * a regional suffix — providers return {@code en_us} and {@code zh-Hans},
     * and the first two letters are the answer in both. Deliberately forgiving
     * on input and strict on output: everything stored and compared downstream
     * is the bare code, so there is exactly one spelling in the database.
     */
    public static Optional<Language> find(String raw) {
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        String value = raw.trim().toLowerCase(Locale.ROOT);
        String base = value.split("[-_]")[0];

        return Arrays.stream(values())
                .filter(l -> l.code.equals(base)
                        || l.englishName.toLowerCase(Locale.ROOT).equals(value)
                        || l.nativeName.toLowerCase(Locale.ROOT).equals(value))
                .findFirst();
    }

    /** The English name, for a code we may not know — a label, never a lookup key. */
    public static String label(String raw) {
        return find(raw).map(Language::englishName).orElse(raw);
    }
}
