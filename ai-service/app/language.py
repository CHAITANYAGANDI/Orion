"""Per-utterance language detection, for meetings that switch languages.

Providers report **one** language for a whole recording. That is right for most
meetings and wrong for the ones people actually complain about: a standup held
half in Telugu and half in English gets labelled `te`, the summary is written in
Telugu, and the English half of the transcript sits under a label that does not
describe it.

This annotates each utterance, so the transcript can say which lines were in
which language and the UI can mark the minority ones.

Two mechanisms, in order of confidence:

1. **Script.** Devanagari is not English. This is a property of the codepoints
   rather than a guess, so where a script maps to exactly one language of
   interest the answer is certain and needs no threshold.

2. **Stopwords**, only for Latin script, where the script says nothing. A short
   list of the most frequent function words per language, scored by how many of
   the utterance's tokens are in each list.

The important behaviour is that this **returns None when unsure**. A wrong
language label is worse than no label: it would move a line into a language it
is not in, and downstream that changes how the text is summarised and
translated. "Okay." is not evidence of anything, and neither is a proper noun.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter

# --------------------------------------------------------------------------- #
# Script ranges
#
# Only scripts that identify a language on their own. Latin is deliberately
# absent: it carries dozens of languages and says nothing by itself.
# --------------------------------------------------------------------------- #
_SCRIPT_LANGUAGE: dict[str, str] = {
    "TELUGU": "te",
    "DEVANAGARI": "hi",       # also Marathi/Nepali; Hindi is the common case here
    "TAMIL": "ta",
    "KANNADA": "kn",
    "MALAYALAM": "ml",
    "BENGALI": "bn",
    "GUJARATI": "gu",
    "GURMUKHI": "pa",
    "ORIYA": "or",
    "SINHALA": "si",
    "THAI": "th",
    "LAO": "lo",
    "KHMER": "km",
    "MYANMAR": "my",
    "ARABIC": "ar",
    "HEBREW": "he",
    "GREEK": "el",
    "CYRILLIC": "ru",         # also uk/bg/sr; Russian is the common case here
    "ARMENIAN": "hy",
    "GEORGIAN": "ka",
    "HANGUL": "ko",
    "ETHIOPIC": "am",
}

# Japanese is the one script question that is genuinely ambiguous: Japanese text
# mixes Han with kana, and Han alone is Chinese. Kana is therefore the tell.
_KANA = ("HIRAGANA", "KATAKANA")

# The most frequent function words per language. Function words are used because
# they are the words a speaker cannot avoid, so they survive in short utterances
# where content words are all proper nouns.
_STOPWORDS: dict[str, frozenset[str]] = {
    "en": frozenset("""the a an and or but if then so of in on at to for with from
        is are was were be been being do does did have has had i you he she it we
        they this that these those not no yes what when where who how why can
        could would should will just about there their our your my me him her
        them as by than very really okay right now""".split()),
    "es": frozenset("""el la los las un una unos unas y o pero si entonces de en
        con por para desde es son era eran ser estar que no sí qué cuando donde
        quien como porque yo tú él ella nosotros ellos este esta eso muy ahora
        también pero más bien vale""".split()),
    "fr": frozenset("""le la les un une des et ou mais si donc de dans sur à pour
        avec depuis est sont était étaient être que ne pas oui quoi quand où qui
        comment pourquoi je tu il elle nous ils ce cette très maintenant aussi
        plus bien alors""".split()),
    "de": frozenset("""der die das ein eine und oder aber wenn dann von in auf zu
        für mit aus ist sind war waren sein dass nicht ja was wann wo wer wie
        warum ich du er sie wir ihr diese dieser sehr jetzt auch mehr gut also
        noch schon""".split()),
    "pt": frozenset("""o a os as um uma e ou mas se então de em com por para desde
        é são era eram ser que não sim que quando onde quem como porque eu tu ele
        ela nós eles este esta isso muito agora também mais bem então""".split()),
    "it": frozenset("""il lo la i gli le un una e o ma se allora di in su a per con
        da è sono era erano essere che non sì cosa quando dove chi come perché io
        tu lui lei noi loro questo questa molto adesso anche più bene""".split()),
    "nl": frozenset("""de het een en of maar als dan van in op naar voor met uit is
        zijn was waren dat niet ja wat wanneer waar wie hoe waarom ik jij hij zij
        wij deze dit heel nu ook meer goed dus nog al""".split()),
}

_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)

# Below this many word tokens there is not enough signal to call it. "Okay." and
# "Yeah, sure" are ambiguous in most Latin-script languages.
_MIN_LATIN_TOKENS = 4
# Ratio of tokens that must be stopwords of the winning language, and how far
# ahead of the runner-up it must be. Both matter: a high score for two languages
# at once means the shared vocabulary won, not the language.
_MIN_STOPWORD_RATIO = 0.20
_MIN_MARGIN = 2


def _script_of(char: str) -> str | None:
    """The Unicode script block name for a letter, or None if it is not one."""
    try:
        name = unicodedata.name(char)
    except ValueError:
        return None
    # Unicode names begin with the script: "TELUGU LETTER A", "CYRILLIC SMALL ...".
    return name.split(" ")[0] if " " in name else None


def detect_language(text: str) -> str | None:
    """Best-effort ISO-639-1 code for one utterance, or None when unsure.

    None is a real and common answer: short utterances, numbers, names, and
    anything whose script does not settle the question and whose words are not
    distinctive. Callers should treat None as "same as the meeting" rather than
    as a failure.
    """
    if not text or not text.strip():
        return None

    # --- 1. Script ---------------------------------------------------------- #
    scripts: Counter[str] = Counter()
    for char in text:
        if not char.isalpha():
            continue
        script = _script_of(char)
        if script:
            scripts[script] += 1

    if not scripts:
        return None  # digits, punctuation, emoji — nothing to go on

    if any(scripts.get(kana) for kana in _KANA):
        return "ja"

    total_letters = sum(scripts.values())
    for script, count in scripts.most_common():
        language = _SCRIPT_LANGUAGE.get(script)
        if language and count / total_letters >= 0.30:
            # A minority of non-Latin characters in an otherwise English line is
            # usually a borrowed name, so a real share of the letters is
            # required before the line is called that language.
            return language
        if script == "CJK":  # "CJK UNIFIED IDEOGRAPH-XXXX", no kana seen above
            return "zh"

    # --- 2. Stopwords, Latin only ------------------------------------------- #
    if scripts.most_common(1)[0][0] != "LATIN":
        return None

    tokens = [t.lower() for t in _WORD.findall(text)]
    if len(tokens) < _MIN_LATIN_TOKENS:
        return None

    scores = {
        language: sum(1 for t in tokens if t in words)
        for language, words in _STOPWORDS.items()
    }
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    best, best_score = ranked[0]
    runner_up_score = ranked[1][1] if len(ranked) > 1 else 0

    if best_score / len(tokens) < _MIN_STOPWORD_RATIO:
        return None
    if best_score - runner_up_score < _MIN_MARGIN:
        # Two languages scoring alike means the shared Romance/Germanic
        # vocabulary matched, not that we recognised the language.
        return None
    return best


def annotate_segments(segments: list, default_language: str | None = None) -> None:
    """Set `.language` on each segment, in place.

    A segment whose detected language matches the meeting's, or which cannot be
    called, is left as None. Only the lines that differ carry a label, so the UI
    can mark the exceptions without tagging every line in a monolingual meeting.
    """
    default = (default_language or "").split("-")[0].lower() or None
    for segment in segments:
        detected = detect_language(getattr(segment, "text", "") or "")
        segment.language = detected if detected and detected != default else None
