"""The launch-planning meeting: five provider labels, six people, two names.

The third human-verified production timeline and the most complete one — a full
transcript with every turn timestamped, so the provider's own labelling can be
reconstructed exactly rather than sampled.

## What it is for

By this recording the opening alternation and the interruption fragments are
gone. What is left is the case none of the earlier work could reach:

```
[02:03]  Speaker 4   Not in real time, but source feedback...
[03:01]  Speaker 4   Yep, that's where we were last I heard.
[09:32]  Speaker 4   Yeah, and that would help me with the plan stuff...
```

Human verification says the third is somebody else — and unlike the cadence
turn, **that somebody speaks nowhere else in the meeting**. There is no existing
voice to hand the region to, so the only representation available is a new
canonical speaker, which is the one correction this module has always refused to
make. It is also the third separate report of this same case.

Two smaller ones sit beside it, and both are single turns the provider filed
under the wrong person while that person goes on being real elsewhere:

```
[02:01]  Speaker 1   Yeah, same.          -> really Speaker 4
[08:51]  Speaker 1   But I--              -> really Brian
```

## Where the provider labels come from

`CanonicalSpeakers` is a bijection from raw token to `Speaker N`, assigned by
first appearance and never reused, so the displayed numbering is invertible.
Ordering the transcript's own labels by first appearance gives:

    A -> Speaker 1   B -> Speaker 2 ("Sydney")   C -> Speaker 3
    D -> Speaker 4   E -> Speaker 5 ("Brian")

and the transcript shows exactly `Speaker 1`, `Sydney`, `Speaker 3`,
`Speaker 4`, `Brian` — no `Speaker 2` and no `Speaker 5`, because those two
ordinals are spent on the speakers transcript naming found names for. That the
gaps land precisely where the names are is what makes the reconstruction a
deduction rather than a guess.

## The names

`Sydney` is wrong: she is Cindy, and the meeting says so twice — *"it may end
up, Cindy, being you and I"* and *"to Cindy's comment"*. The one turn that
produced the name, *"What do you think, Sydney?"*, is the transcriber mishearing
the same word. Nothing about attribution is wrong there; the acoustic grouping
of her turns is correct and the name written over them is not, which is why she
appears here as `Cindy` in the truth column and why the naming tests live
alongside this fixture rather than inside it.
"""

from __future__ import annotations

from tests.meeting_fixture import assemble, mm, nearby, stamp, voice

__all__ = ["TIMELINE", "build", "mm", "stamp"]


#: Six people under five provider labels. Speaker 3 and Cindy are deliberately
#: close in the embedding space: a fixture where everyone is orthogonal cannot
#: fail a false merge, so it cannot prove one is impossible.
MAIN, S3, S4, BRIAN, S5 = (voice(n) for n in (31, 32, 33, 34, 35))
CINDY = nearby(S3, voice(36), 0.40)


#: `(start, duration, provider_label, acoustic_truth, human_label, note)`
TIMELINE = [
    (mm("0:01"), 71.0, "A", MAIN,   "Main",      ""),
    (mm("1:12"),  5.0, "B", CINDY,  "Cindy",     ""),
    (mm("1:17"), 38.0, "A", MAIN,   "Main",      ""),
    (mm("1:55"),  6.0, "C", S3,     "Speaker 3", ""),

    # "Yeah, same." -- two seconds the provider gave to the main speaker and
    # Speaker 4 said, running straight into their own next turn.
    (mm("2:01"),  2.0, "A", S4,     "Speaker 4", "island: provider says A, really S4"),
    (mm("2:03"), 14.0, "D", S4,     "Speaker 4", ""),

    (mm("2:17"), 10.0, "A", MAIN,   "Main",      ""),

    # The cadence line. Eight seconds under Brian's label that the main speaker
    # said -- the longest-standing error in this investigation, reported against
    # three separate recordings and still wrong in both shipped builds.
    (mm("2:27"),  8.0, "E", MAIN,   "Main",      "cadence: provider says E, really Main"),
    (mm("2:35"),  1.0, "A", MAIN,   "Main",      '"Okay."'),
    (mm("2:36"),  8.0, "C", S3,     "Speaker 3", ""),
    (mm("2:44"), 17.0, "A", MAIN,   "Main",      ""),
    (mm("3:01"),  1.0, "C", S3,     "Speaker 3", '"Yep."'),
    (mm("3:02"),  2.0, "D", S4,     "Speaker 4", ""),
    (mm("3:04"), 57.0, "A", MAIN,   "Main",      ""),
    (mm("4:01"),  9.0, "B", CINDY,  "Cindy",     ""),
    (mm("4:10"), 100.0, "A", MAIN,  "Main",      ""),
    (mm("5:50"), 30.0, "B", CINDY,  "Cindy",     ""),
    (mm("6:20"), 24.0, "A", MAIN,   "Main",      ""),
    (mm("6:44"),  2.0, "B", CINDY,  "Cindy",     ""),
    (mm("6:46"), 24.0, "A", MAIN,   "Main",      ""),
    (mm("7:10"), 101.0, "E", BRIAN, "Brian",     ""),

    # "But I--" -- six tenths of a second inside a Brian monologue, which the
    # provider handed to the main speaker.
    (mm("8:51"),  0.6, "A", BRIAN,  "Brian",     "island: provider says A, really Brian"),
    (mm("8:52"), 10.0, "E", BRIAN,  "Brian",     ""),

    (mm("9:02"), 30.0, "C", S3,     "Speaker 3", ""),

    # Forty-eight seconds under Speaker 4's label, spoken by somebody who is
    # nowhere else in the meeting. The case that needs a speaker created.
    #
    # Neutrally identified, because that is the whole of what a person verified:
    # this is somebody else. The transcript elsewhere says "Cormac was saying
    # ...", which is third-person content about a person who may not be in the
    # room, and it is exactly the kind of evidence `app.naming` refuses. It must
    # not become ground truth here either.
    (mm("9:32"), 48.0, "D", S5,     "Speaker 5", "label D's second voice"),

    (mm("10:20"), 5.0, "A", MAIN,   "Main",      ""),
    (mm("10:25"), 11.0, "E", BRIAN, "Brian",     ""),
    (mm("10:36"), 27.0, "A", MAIN,  "Main",      ""),
    (mm("11:03"), 36.0, "C", S3,    "Speaker 3", ""),
    (mm("11:39"), 30.0, "A", MAIN,  "Main",      ""),
]


def build():
    """`(segments, sampler_factory, expected)` for the meeting above."""
    return assemble(TIMELINE)
