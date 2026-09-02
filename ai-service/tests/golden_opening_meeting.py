"""The eleven-minute meeting whose opening alternates between two speakers.

The second human-verified production timeline, and the one that showed the
failure is not a family of special cases but a single structural mistake:

```
[00:00]  Speaker 1     And we don't have a ton of items to get to...
[00:14]  Speaker 2     So corporate events, they--
[00:21]  Speaker 1     I put this in Slack...
[00:27]  Speaker 2     You know, the nutshell here is...
```

One person said all four. Everything upstream reasoned in provider-label space,
where a label *was* an identity, so an alternation the provider produced was an
alternation Reverie reproduced — and the same recording contains the opposite
error too, a label holding a four-second turn somebody else said.

## Where the provider labels come from

The human verification gives who really spoke. The provider's own tokens are not
in a rendered transcript, so they are reconstructed from the one property that
makes them recoverable: `CanonicalSpeakers` is a **bijection** from raw token to
`Speaker N`, assigned by first appearance and never reused. Two turns rendered
under different numbers therefore had different raw tokens, and two under the
same number had the same one. Ordering the displayed labels by first appearance
gives:

    A -> Speaker 1   B -> Speaker 2   C -> Sydney
    D -> Speaker 4   E -> Speaker 5   F -> Brian

`Sydney` and `Brian` are transcript-inferred names sitting on canonical
speakers, which is why they occupy ordinals without showing them.

What this reconstruction **cannot** recover is whether a given alternation was
an utterance-level label change or a stray word-level run promoted by
`split_by_speaker`. Both render identically. It is modelled here as
utterance-level, which is the conservative reading — it assumes the provider
really did say what Reverie displayed — and `SpeakerRefiner._trace_regions`
exists to settle it on the real recording, where the word labels survive.

## Durations

Timestamps give the starts. Durations are the gap to the next row, except for
the interruption fragments, which are estimated from what they say: a broken
word ("and I'm--", "And that--") under a second, a complete short phrase
("Absolutely, yeah.", "Cool.") around one, a short question about one and a
half. They are estimates and they matter, because the embedder refuses below
0.8s — so a fragment's length decides whether there is any acoustic evidence
about it at all, which is the difference between a correction and a guess.
"""

from __future__ import annotations

from tests.meeting_fixture import assemble, mm, nearby, stamp, voice

__all__ = ["TIMELINE", "build", "mm", "stamp"]


#: Five people. Speaker 4 and Speaker 5 are deliberately close in the embedding
#: space, because a fixture where everyone is orthogonal cannot fail a false
#: merge and so cannot prove one is impossible.
MAIN, SYDNEY, BRIAN, S4 = (voice(n) for n in (21, 22, 23, 24))
S5 = nearby(S4, voice(25), 0.55)


#: `(start, duration, provider_label, acoustic_truth, human_label, note)`
TIMELINE = [
    # The opening. One voice, four turns, two provider labels -- the highest
    # priority bug in the report and the reason this file exists.
    (mm("0:00"), 14.0, "A", MAIN,   "Main",      ""),
    (mm("0:14"),  7.0, "B", MAIN,   "Main",      "same voice, second provider label"),
    (mm("0:21"),  6.0, "A", MAIN,   "Main",      ""),
    (mm("0:27"), 40.0, "B", MAIN,   "Main",      "same voice, second provider label"),

    (mm("1:08"),  5.0, "C", SYDNEY, "Sydney",    ""),
    (mm("1:13"), 41.0, "A", MAIN,   "Main",      ""),
    (mm("1:55"),  3.0, "D", S4,     "Speaker 4", "the one legitimate Speaker 4 turn"),
    (mm("1:58"), 15.0, "E", S5,     "Speaker 5", ""),
    (mm("2:13"), 11.0, "B", MAIN,   "Main",      ""),

    # The cadence line. Four seconds under Brian's label that the main speaker
    # said, proved by that label's own regions disagreeing with each other.
    (mm("2:24"),  4.0, "F", MAIN,   "Main",      "cadence: provider says F, really Main"),
    (mm("2:31"),  6.0, "F", BRIAN,  "Brian",     ""),

    (mm("2:37"),  2.0, "A", MAIN,   "Main",      '"Cool."'),
    (mm("2:41"), 19.0, "B", MAIN,   "Main",      ""),
    (mm("3:00"), 59.0, "A", MAIN,   "Main",      ""),
    (mm("3:59"),  8.0, "C", SYDNEY, "Sydney",    ""),
    (mm("4:07"), 19.0, "B", MAIN,   "Main",      ""),

    # Three interruption fragments the provider gave to Speaker 4 and one it
    # gave to Speaker 5. All four are the main speaker carrying on.
    (mm("4:26"),  0.6, "D", MAIN,   "Main",      '"and I\'m--", below the embedder floor'),
    (mm("4:28"), 77.0, "B", MAIN,   "Main",      ""),
    (mm("5:45"),  1.4, "E", MAIN,   "Main",      '"What do you think, Sydney?"'),
    (mm("5:46"), 32.0, "C", SYDNEY, "Sydney",    ""),
    (mm("6:18"),  1.0, "D", MAIN,   "Main",      '"Absolutely, yeah."'),
    (mm("6:19"), 21.0, "B", MAIN,   "Main",      ""),

    (mm("6:40"),  4.0, "C", SYDNEY, "Sydney",    ""),
    (mm("6:44"), 19.0, "B", MAIN,   "Main",      ""),
    (mm("7:03"), 145.0, "F", BRIAN, "Brian",     ""),

    # Human-verified correct in the deployed build, and a regression gate: no
    # algorithm is acceptable that folds this back onto Speaker 4.
    (mm("9:28"), 45.0, "E", S5,     "Speaker 5", "correct today; must stay correct"),

    (mm("10:13"), 6.0, "B", MAIN,   "Main",      ""),
    (mm("10:19"), 13.0, "F", BRIAN, "Brian",     ""),
    (mm("10:32"), 0.7, "D", MAIN,   "Main",      '"And that--", below the embedder floor'),
    (mm("10:37"), 18.0, "B", MAIN,  "Main",      ""),
]


def build():
    """`(segments, sampler_factory, expected)` for the meeting above."""
    return assemble(TIMELINE)
