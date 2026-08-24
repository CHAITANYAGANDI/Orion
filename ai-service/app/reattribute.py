"""Write a reconciliation back onto the transcript's segments.

The reconciler answers a question about words. The rest of Recallix reads
segments. This is the one place that turns the first into the second, and it is
separate from ``app.reconcile`` so that the decision *who spoke* stays a pure
function of times and can be tested without constructing a transcript.

<h2>Re-splitting, not editing</h2>

A segment is not patched in place. Its words are relabelled and then handed to
``split_by_speaker``, which is the same function the adapters use, so a turn the
diarizer split into three comes out as three segments built the same way every
other segment in the transcript was. The alternative -- rewriting a segment's
``speaker`` and leaving its words alone -- produces a turn whose label
contradicts its own contents, which is worse than the bug being fixed.

<h2>What is preserved</h2>

Text, word timings and word count are unchanged; only attribution moves. The
provider's own token survives on each word and on each segment as
``speaker_raw``, which is what makes a complaint traceable afterwards.

<h2>When nothing is known</h2>

A word the reconciler declined keeps no speaker of its own. Inside a run it
continues that run -- ``split_by_speaker`` already treats an unlabelled word as
continuing rather than as an unattributed island, because honouring every gap
shreds a sentence into alternating known and unknown fragments. A whole run of
declined words becomes a segment with ``speaker_status="unknown"``, which the
UI already renders as an unattributed turn.
"""

from __future__ import annotations

import logging

from app.diarization import (
    CanonicalSpeakers,
    SpokenWord,
    join_words,
    split_by_speaker,
)
from app.reconcile import Reconciliation
from app.schemas import Segment, Word

logger = logging.getLogger("ai-service.reattribute")


def reattribute(segments: list[Segment], result: Reconciliation) -> list[Segment]:
    """Rebuild ``segments`` with the reconciler's speakers.

    ``result`` must have been produced from exactly these segments' words, in
    order; the two are zipped positionally. Returns the input unchanged if it
    was not, because a misaligned rewrite would move text between speakers
    silently and that is the one outcome worse than not running at all.
    """
    flat = flatten(segments)
    if len(flat) != len(result.verdicts):
        logger.warning(
            "reattribution skipped: %d words in segments, %d verdicts.",
            len(flat), len(result.verdicts),
        )
        return segments

    # The provider's token, kept per word for the trace. Carried alongside
    # rather than looked up later: the verdicts are already positional with
    # `flat`, and searching them per word turns an hour-long meeting into a
    # ten-thousand-squared scan.
    raw_of: dict[int, str | None] = {}
    for word, verdict in zip(flat, result.verdicts):
        word.speaker = _token(verdict.key)
        raw_of[id(word)] = verdict.raw

    speakers = CanonicalSpeakers()
    rebuilt: list[Segment] = []
    for run in split_by_speaker(flat, speakers):
        if not run.words:
            continue
        rebuilt.append(
            Segment(
                start=run.start,
                end=run.end,
                speaker=run.identity.label,
                speaker_key=run.identity.key,
                speaker_raw=_provider_token(run.words, raw_of),
                speaker_status=run.identity.status,
                text=join_words(run.words, capitalise=run.split),
                words=[
                    Word(
                        text=w.text,
                        start=w.start,
                        end=w.end,
                        confidence=w.confidence,
                        speaker=w.speaker,
                        speaker_raw=raw_of.get(id(w)),
                    )
                    for w in run.words
                ],
            )
        )
    return rebuilt


def flatten(segments: list[Segment]) -> list[SpokenWord]:
    """Every word in the transcript, in order, as the reconciler wants them.

    Exported because the caller has to build the *same* list to hand to
    ``assign``: the two are zipped positionally afterwards, and a transcript
    where only some segments carry word timings can otherwise be flattened two
    different ways and two different lengths.
    """
    return [w for seg in segments for w in _words_of(seg)]


def _token(key: str | None) -> str | None:
    """A reconciler key as a token ``CanonicalSpeakers`` will read as a cluster.

    ``spk_2`` handed over whole would be classified as a name and displayed
    literally -- ``is_generic_cluster`` only recognises single characters,
    digits and channel ids -- so the transcript would read "spk_2 said". The
    ordinal alone is a digit, which is what that check is looking for.

    The final numbering is then ``CanonicalSpeakers``', not the reconciler's.
    Both number by first appearance so they normally agree; where they do not,
    the canonical one wins, because it is the numbering the rest of the
    transcript, the colours and the rename all already use.
    """
    if not key:
        return None
    return key.removeprefix("spk_")


def _words_of(segment: Segment) -> list[SpokenWord]:
    """A segment's words, or the segment itself when it has none.

    Providers that time only whole utterances still have to go through this,
    and a segment with no words is one word as far as reconciliation is
    concerned. That keeps the positional zip above honest for both shapes.
    """
    if segment.words:
        # `w.speaker or segment.speaker`: providers label the words they are
        # confident about and leave gaps mid-utterance. An unlabelled word still
        # belongs to the turn it sits in, and the provider label is what the
        # fallback translation is learned from -- dropping it here would lose
        # the speaker of every word the provider happened not to tag.
        return [
            SpokenWord(text=w.text, start=w.start, end=w.end,
                       confidence=w.confidence, speaker=w.speaker or segment.speaker)
            for w in segment.words
        ]
    return [SpokenWord(text=segment.text, start=segment.start, end=segment.end,
                       confidence=segment.confidence, speaker=segment.speaker)]


def _provider_token(
    words: list[SpokenWord], raw_of: dict[int, str | None]
) -> str | None:
    """The provider label this run mostly came from, for the trace.

    Mostly rather than first: a run the diarizer assembled from two of the
    provider's turns should be traceable to whichever it took most of, and the
    first word is an arbitrary tiebreak that would point at the smaller half
    half the time.
    """
    counts: dict[str, int] = {}
    for word in words:
        raw = raw_of.get(id(word))
        if raw:
            counts[raw] = counts.get(raw, 0) + 1
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]
