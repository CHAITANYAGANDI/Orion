"""The human-verified production meeting, as a fixture both algorithms can run.

Built from the timeline in the regression report rather than from synthetic
shapes, because synthetic micro-tests passed while production got worse — which
is the whole reason this file exists. Every row carries three things:

    when it starts, what the provider called it, and who really spoke.

The provider labels are the ones consistent with both observed transcripts, and
the acoustic truth is the human verification. Where the two disagree, that row
*is* a provider error and is the thing under test.

Nothing here reads the words. The text column exists so a failure report is
legible to a person; no rule may consult it.
"""

from __future__ import annotations

from tests.meeting_fixture import assemble, mm, stamp, voice

__all__ = ["TIMELINE", "build", "mm", "stamp"]


#: The people actually in the room. Brian and Speaker 5 are deliberately near
#: each other in the space -- real meetings contain voices a model finds
#: similar, and a fixture where everyone is orthogonal proves nothing about
#: merging.
SYDNEY, S1, S3, S4, S5, BRIAN = (voice(n) for n in (11, 12, 13, 14, 15, 16))


#: `(start, duration, provider_label, acoustic_truth, human_label, note)`
#:
#: `human_label` is what the transcript should say. `acoustic_truth` is whose
#: voice is really in the audio; the two differ only in that one is a name for
#: the other.
TIMELINE = [
    (mm("1:13"),  4.0,  "A", SYDNEY, "Sydney",    ""),
    (mm("1:17"),  0.5,  "C", S1,     "Speaker 1", "fragment: provider says C, really S1"),
    (mm("1:18"), 41.0,  "B", S1,     "Speaker 1", ""),
    (mm("1:59"),  3.0,  "C", S3,     "Speaker 3", ""),
    (mm("2:02"),  2.0,  "D", S4,     "Speaker 4", "leading fragment of one S4 turn"),
    (mm("2:04"), 13.0,  "D", S4,     "Speaker 4", ""),
    (mm("2:18"), 15.0,  "B", S1,     "Speaker 1", ""),
    (mm("2:33"),  4.0,  "F", S1,     "Speaker 1", "cadence: provider says F, really S1"),
    (mm("2:37"),  6.0,  "C", S3,     "Speaker 3", ""),
    (mm("2:43"), 18.0,  "B", S1,     "Speaker 1", ""),
    (mm("3:01"),  1.0,  "C", S3,     "Speaker 3", ""),
    (mm("3:02"),  2.0,  "D", S4,     "Speaker 4", ""),
    (mm("3:04"),  2.0,  "B", S1,     "Speaker 1", "leading fragment of one S1 turn"),
    (mm("3:06"), 57.0,  "B", S1,     "Speaker 1", ""),
    (mm("4:03"), 60.0,  "A", SYDNEY, "Sydney",    ""),
    # Two short, clean turns of Brian's. Without them, label F's only short turn
    # is the mislabelled cadence line at 2:33 — so F's reference gets built from
    # Speaker 1's voice, F and B come out identical, and the "too alike to
    # judge" gate declines the entire meeting. The first version of this fixture
    # did exactly that, and it is a real fragility worth remembering: preferring
    # short turns can build a speaker's whole reference out of one mislabelled
    # fragment.
    (mm("6:30"),  4.0,  "F", BRIAN,  "Brian",     ""),
    (mm("7:05"),  3.0,  "F", BRIAN,  "Brian",     ""),
    (mm("7:10"), 85.0,  "F", BRIAN,  "Brian",     ""),
    (mm("8:35"),  0.5,  "C", BRIAN,  "Brian",     "fragment: provider says C, really Brian"),
    (mm("8:36"), 21.0,  "F", BRIAN,  "Brian",     ""),
    (mm("8:57"),  0.6,  "C", BRIAN,  "Brian",     "fragment: provider says C, really Brian"),
    (mm("8:58"), 10.0,  "F", BRIAN,  "Brian",     ""),
    (mm("9:08"), 24.0,  "C", S3,     "Speaker 3", ""),
    (mm("9:32"), 49.0,  "D", S5,     "Speaker 5", "same label D as S4, different person"),
    (mm("10:21"), 5.0,  "B", S1,     "Speaker 1", ""),
    (mm("10:26"), 30.0, "F", BRIAN,  "Brian",     ""),
]


def build():
    """`(segments, sampler_factory, expected)` for the meeting above."""
    return assemble(TIMELINE)
