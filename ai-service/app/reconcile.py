"""AssemblyAI's words, the diarizer's timeline, one speaker per word.

<h2>The division of labour</h2>

AssemblyAI stays canonical for everything it is good at: what was said, when
each word started and ended, how sure it was. None of that is touched here — a
reconciliation that changed a word or a timestamp would be a transcription
change wearing a diarization label, and the count is asserted before and after.

The diarizer is canonical for *who*. This module is the join.

<h2>Maximum overlap, not the start timestamp</h2>

The obvious implementation is "look up the speaker at ``word.start``", and it is
wrong at exactly the moment it matters. Word timings and diarization boundaries
come from two different models and never agree to the millisecond; a word whose
start falls a few tens of milliseconds on the wrong side of a boundary is
attributed to the previous speaker even though almost all of it was spoken by
the next one. Boundaries are where the errors are, so a rule that is only wrong
at boundaries is wrong everywhere it counts.

So each word is scored against every turn it touches and goes to whichever one
covers most of it. A word that straddles a boundary goes to whoever said more of
it, which is both the defensible answer and the one that agrees with what a
listener hears.

<h2>Who wins where, and why silence is not a verdict</h2>

The diarizer is canonical *where it heard speech*. Where it heard none, it has
not disagreed with the provider — it has said nothing, and those are different
things. Measured on a real recording, a phone call captured through a speaker,
Community-1 reported no speech across a third of a file the provider
transcribed continuously. Treating that silence as a verdict threw away the
speaker of 73 of 296 words, which is a regression against what ships today.

So there are two sources and an explicit precedence:

* the diarizer heard speech — its answer wins, including where it contradicts
  the provider, because that contradiction is the entire point of the rewrite;
* the diarizer heard nothing at all — the provider's label stands, translated
  into the same key space. Today's behaviour is the floor, never the ceiling;
* the diarizer heard speech but cannot say whose — unresolved.

That last case does *not* fall back. The distinction is the whole rule: silence
means no opinion, and an ambiguous boundary means an opinion that is not safe to
act on. Letting the provider win there would hand back exactly the boundaries
the diarizer was brought in to second-guess.

<h2>Refusing rather than guessing</h2>

Two cases still produce no speaker at all:

* the word sits inside a cluster the phantom-speaker guard rejected;
* the best cluster's share of the word does not beat the runner-up by
  ``MARGIN`` — the boundary is genuinely ambiguous.

Unresolved is a real answer and renders as one. Recallix already has
``speaker_status="unknown"`` for precisely this, and filing an ambiguous word
under whoever was nearest is how a transcript comes to quote somebody who did
not speak.

The provider's own label is never *reinterpreted* on the way through. Mapping it
into the key space is decided by time overlap alone, on the words the diarizer
did resolve — never by what the words say.

<h2>What is kept for diagnosis</h2>

Every word keeps the provider's own token in ``speaker_raw``. That is what makes
a complaint traceable — see ``app.diarization.trace_lines`` and §12 of the
brief — and what a later identity pass matches against.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from app.diarize_port import SpeakerTurn, Timeline, canonical_map

logger = logging.getLogger("ai-service.reconcile")

#: A cluster must hold at least this much of a word to claim it outright. Below
#: it the word straddles a boundary evenly enough that either answer is a coin
#: toss, and a coin toss is what "unresolved" exists to avoid.
MARGIN = 0.60

#: Total attributed speech a cluster needs across the whole recording before it
#: is allowed to be a speaker — unless it recurs, which is the other half of the
#: rule. See `canonical_map` for why it is a disjunction, and why this number is
#: small: a floor high enough to stop a determined phantom also deletes the
#: person who only ever said "Morning."
MIN_SPEAKER_SECONDS = 0.4

#: A word with no duration cannot be scored by overlap. Providers do emit them
#: for punctuation-only tokens.
_ZERO = 1e-6

#: Why a word has no cluster. Machine-readable because the fallback rule turns
#: on *which* of these happened, and a rule that switched on English prose would
#: break the next time somebody improved the wording.
SILENT = "silent"        #: the diarizer heard no speech here at all
AMBIGUOUS = "ambiguous"  #: it heard speech but no cluster clearly owns the word
BELOW_FLOOR = "floor"    #: the owning cluster did not earn a speaker

#: Prose for the trace and for `WordVerdict.reason`.
REASONS = {
    SILENT: "outside every diarized turn",
    AMBIGUOUS: "no speaker holds enough of the word",
    BELOW_FLOOR: "cluster below the speech floor",
}


@dataclass
class WordVerdict:
    """One word's outcome, for the trace and the metrics."""

    text: str
    start: float
    end: float
    #: The provider's own label, untouched.
    raw: str | None
    #: The diarizer's cluster, or None where it had nothing to say.
    cluster: str | None
    #: The meeting-local key finally assigned, or None for unresolved.
    key: str | None
    #: Why, when there is no key.
    reason: str = ""
    #: One of SILENT / AMBIGUOUS / BELOW_FLOOR, or "" when the diarizer placed
    #: the word. Survives a provider fallback on purpose: the diarizer really
    #: was silent there, and `silent_seconds` needs to keep counting it even
    #: though the word now has a speaker.
    reason_code: str = ""
    #: True when the key came from the provider because the diarizer was silent.
    from_provider: bool = False

    @property
    def resolved(self) -> bool:
        return self.key is not None


@dataclass
class Reconciliation:
    """What the join did, in numbers safe to put in production telemetry.

    Deliberately counts only. No text, no timings, no speaker names — this is
    the shape that may be emitted from a deployment holding other people's
    meetings, and the per-word detail lives in `verdicts`, which is
    developer-only and never logged above DEBUG.
    """

    words: int = 0
    resolved: int = 0
    unresolved: int = 0
    #: Words where the diarizer's answer differs from the provider's mapping.
    disagreements: int = 0
    #: Speaker changes the diarizer found inside one provider label.
    repaired_boundaries: int = 0
    provider_speakers: int = 0
    diarizer_speakers: int = 0
    #: Clusters dropped by the phantom-speaker guard.
    rejected_clusters: int = 0
    #: Words the diarizer had no opinion on, kept at the provider's label.
    provider_fallbacks: int = 0
    #: Seconds the provider transcribed and the diarizer reported as silence.
    #: A large figure means the diarizer is not hearing this recording, which
    #: is worth an operator's attention even when the output looks fine.
    silent_seconds: float = 0.0
    model: str = ""
    verdicts: list[WordVerdict] = field(default_factory=list)

    def telemetry(self) -> dict[str, object]:
        """The production-safe subset (§12)."""
        return {
            "words": self.words,
            "resolved": self.resolved,
            "unresolved": self.unresolved,
            "disagreement_words": self.disagreements,
            "repaired_boundaries": self.repaired_boundaries,
            "provider_speakers": self.provider_speakers,
            "diarizer_speakers": self.diarizer_speakers,
            "rejected_clusters": self.rejected_clusters,
            "provider_fallbacks": self.provider_fallbacks,
            "silent_seconds": round(self.silent_seconds, 1),
            "model": self.model,
        }


def assign(
    words: list[tuple[str, float, float, str | None]],
    timeline: Timeline,
    *,
    margin: float = MARGIN,
    min_speaker_seconds: float = MIN_SPEAKER_SECONDS,
    fall_back_to_provider: bool = True,
) -> Reconciliation:
    """Give every word a speaker key, or none.

    ``words`` is ``(text, start, end, provider_label)``. Returned in the order
    given, one verdict each — the caller relies on that to write the answers
    back without re-matching.

    ``fall_back_to_provider`` keeps the provider's label where the diarizer
    heard no speech at all. On by default because off is a regression against
    what ships today; the switch exists so the two can be measured against each
    other rather than argued about.
    """
    clean = timeline.normalised()
    mapping, rejected = canonical_map(clean, min_speech_seconds=min_speaker_seconds)

    out = Reconciliation(
        words=len(words),
        diarizer_speakers=len(mapping),
        rejected_clusters=len(rejected),
        model=clean.model,
        provider_speakers=len({w[3] for w in words if w[3]}),
    )

    for text, start, end, raw in words:
        cluster, code = _cluster_for(clean.turns, start, end, margin)
        key = mapping.get(cluster) if cluster else None
        if cluster and key is None:
            # A real acoustic cluster that did not earn a speaker. Its audio is
            # unresolved rather than reassigned: handing it to a neighbour is
            # exactly the phantom the guard exists to stop, one step later.
            code = BELOW_FLOOR
        out.verdicts.append(
            WordVerdict(text=text, start=start, end=end, raw=raw,
                        cluster=cluster, key=key,
                        reason="" if key else REASONS.get(code, code),
                        reason_code="" if key else code)
        )

    if fall_back_to_provider:
        _fill_silence(out, mapping)

    for verdict in out.verdicts:
        if verdict.resolved:
            out.resolved += 1
        else:
            out.unresolved += 1
        if verdict.reason_code == SILENT:
            out.silent_seconds += max(0.0, verdict.end - verdict.start)

    out.disagreements = _count_disagreements(out.verdicts)
    out.repaired_boundaries = _count_repairs(out.verdicts)
    return out


def _fill_silence(out: Reconciliation, mapping: dict[str, str]) -> None:
    """Keep the provider's answer wherever the diarizer heard nothing.

    The provider's labels live in their own namespace ("Speaker 1", "A", "B"),
    so they have to be translated before they can be written back. The
    translation is learned from the words the diarizer *did* resolve: whichever
    key a provider label most often coincides with in time is that label's key.

    Learned rather than assumed, because the two systems number speakers in
    whatever order they happen to meet them and the orders do not have to agree.
    Learned from time alone, never from what the words say.

    A label the diarizer never resolved anywhere gets a key of its own rather
    than being folded into an existing speaker. It is a participant the
    transcript plainly has and the diarizer simply never heard; giving it a
    fresh key keeps it separate, and separate is the recoverable error. Merging
    two people is not.
    """
    votes: dict[str, dict[str, int]] = {}
    for verdict in out.verdicts:
        if verdict.resolved and verdict.raw:
            votes.setdefault(verdict.raw, {})
            votes[verdict.raw][verdict.key] = votes[verdict.raw].get(verdict.key, 0) + 1

    translation = {
        raw: max(counts.items(), key=lambda kv: kv[1])[0]
        for raw, counts in votes.items()
        if counts
    }
    # A provider label the diarizer never resolved anywhere still deserves a
    # speaker of its own: the alternative is dropping a participant the
    # transcript clearly has. It gets a fresh key rather than an existing one,
    # because merging it into somebody else is the error that cannot be undone.
    spare = len(set(mapping.values()))
    for verdict in out.verdicts:
        if verdict.resolved or verdict.reason_code != SILENT or not verdict.raw:
            continue
        if verdict.raw not in translation:
            spare += 1
            translation[verdict.raw] = f"spk_{spare}"
        verdict.key = translation[verdict.raw]
        verdict.from_provider = True
        verdict.reason = ""
        out.provider_fallbacks += 1


def _cluster_for(
    turns: list[SpeakerTurn], start: float, end: float, margin: float
) -> tuple[str | None, str]:
    """Whoever spoke most of ``[start, end)``, if clearly enough."""
    if end - start <= _ZERO:
        # Zero-length token — punctuation the provider emitted on its own. Use
        # the instant it sits at, since there is no span to share out.
        for turn in turns:
            if turn.start <= start < turn.end:
                return turn.speaker, ""
        return None, SILENT

    shares: dict[str, float] = {}
    for turn in turns:
        seconds = turn.overlap(start, end)
        if seconds > 0:
            shares[turn.speaker] = shares.get(turn.speaker, 0.0) + seconds

    if not shares:
        return None, SILENT

    ranked = sorted(shares.items(), key=lambda kv: kv[1], reverse=True)
    duration = end - start
    best, best_seconds = ranked[0]

    if best_seconds / duration < margin:
        # Either the word is mostly outside any turn, or it is split too evenly
        # between two. Both are boundaries this cannot call.
        return None, AMBIGUOUS
    return best, ""


def _count_disagreements(verdicts: list[WordVerdict]) -> int:
    """Words where the diarizer split what the provider called one voice.

    Measured as a *relation* rather than by comparing labels directly: the two
    systems name speakers independently, so "provider said B and diarizer said
    D0" is not itself a disagreement. What counts is two words the provider gave
    the same label being given different keys, or the reverse.
    """
    by_raw: dict[str, set[str]] = {}
    for v in verdicts:
        if v.raw and v.key:
            by_raw.setdefault(v.raw, set()).add(v.key)
    split_labels = {raw for raw, keys in by_raw.items() if len(keys) > 1}
    if not split_labels:
        return 0
    # The minority key under each split label is the part that moved.
    moved = 0
    for raw in split_labels:
        counts: dict[str, int] = {}
        for v in verdicts:
            if v.raw == raw and v.key:
                counts[v.key] = counts.get(v.key, 0) + 1
        majority = max(counts.values())
        moved += sum(counts.values()) - majority
    return moved


def _count_repairs(verdicts: list[WordVerdict]) -> int:
    """Speaker changes that happen inside a single provider label."""
    repairs = 0
    for previous, current in zip(verdicts, verdicts[1:]):
        if not previous.key or not current.key:
            continue
        if previous.key != current.key and previous.raw == current.raw and previous.raw:
            repairs += 1
    return repairs


def trace(reconciliation: Reconciliation) -> list[str]:
    """The §12 developer view: one line per word, all three opinions on it.

        00:25.03 "home."  AAI=B  diar=D1  final=spk_2

    Contains transcript text, so it is developer-only by construction. The
    caller gates it on DEBUG; nothing here should reach production logs.
    """
    lines = []
    for v in reconciliation.verdicts:
        stamp = f"{int(v.start // 60):02d}:{v.start % 60:05.2f}"
        lines.append(
            f'{stamp} "{v.text}"'
            f'  AAI={v.raw or "-"}'
            f'  diar={v.cluster or "-"}'
            f'  final={v.key or "unresolved"}'
            + (f"  ({v.reason})" if v.reason else "")
        )
    return lines
