"""Two names for one speaker, and which one the meeting actually supports.

The failure this file is shaped around: automatic speech recognition hears one
participant's name several times and gets it wrong once — *Cindy, Cindy, Cindy,
Sydney* — and the transcript came out saying **Sydney**. Not because Sydney was
better supported, but because support was counted in the wrong place.

`resolve` used to tally the *claims a model returned*. A claim is a model saying
"this name is worth considering, and here is a sentence containing it"; it is
not a count of how often the meeting said so. So the arithmetic was over how
many times a model chose to mention something, and the three turns that said
Cindy were never counted, because nothing went looking for them. One
mistranscribed vocative that the model happened to quote outranked them all.

The fix separates the two jobs. Claims nominate candidates; the **meeting**
decides between them, by re-running the same structural checks over every turn.
These tests are written so that they fail against the old arithmetic: in most of
them the model returns exactly as many claims for the wrong name as for the
right one, or more.

Names here are the ones from the report, used as fixtures. Nothing in `app/`
knows them — no rule, list or threshold anywhere refers to a name, a phrase or a
meeting, and a general fix is the only kind that could pass both directions of
the first two tests.
"""

from __future__ import annotations

from app import naming
from app.schemas import Segment, SpeakerNameClaim


def seg(speaker: str, text: str, start: float = 0.0, seconds: float = 3.0,
        **extra) -> Segment:
    return Segment(
        start=start, end=start + seconds, speaker=speaker, text=text,
        speaker_key=extra.pop("key", None), **extra,
    )


def claim(speaker: str, name: str, turn: int, quote: str,
          basis: str = "addressed") -> SpeakerNameClaim:
    return SpeakerNameClaim(
        speaker=speaker, name=name, turn=turn, quote=quote, basis=basis
    )


def conversation(*lines: str) -> list[Segment]:
    """Alternating speakers, one turn each, all of them soundly owned.

    Alternating on purpose: every turn then has the other speaker within reach,
    so the adjacency rule is satisfied by construction and these tests are about
    the weighing rather than about who was standing near whom.
    """
    return [
        seg(f"Speaker {index % 2 + 1}", text, start=index * 4.0,
            key=f"spk_{index % 2 + 1}")
        for index, text in enumerate(lines)
    ]


class TestConflictingTranscriptionsOfOneName:
    """The reported bug, and the same bug pointing the other way."""

    #: Three vocatives, one of which ASR heard as a different name. The model is
    #: given one claim for each spelling — an even split by the old arithmetic.
    MOSTLY_CINDY = (
        "It may end up, Cindy, being you and I on this.",
        "That works for me.",
        "What do you think, Cindy?",
        "I think we should ship it.",
        "Thanks Sydney, that helps.",
        "No problem.",
    )

    def test_repeated_evidence_outweighs_one_conflicting_transcription(self):
        segments = conversation(*self.MOSTLY_CINDY)
        claims = [
            claim("Speaker 2", "Cindy", 1, "It may end up, Cindy, being you and I"),
            claim("Speaker 2", "Sydney", 5, "Thanks Sydney"),
        ]

        # One claim each. The meeting says Cindy twice and Sydney once, and it
        # is the meeting that decides -- under the old tally this was 1-1 and
        # refused, and if the model had quoted only the Sydney turn it resolved
        # to Sydney outright.
        assert naming.resolve(claims, segments) == {"Speaker 2": "Cindy"}

    def test_the_same_rule_runs_the_other_way(self):
        # The proof that nothing is hardcoded: the identical fixture with the
        # names exchanged resolves to the other name.
        swapped = [
            text.replace("Cindy", "TEMP").replace("Sydney", "Cindy").replace("TEMP", "Sydney")
            for text in self.MOSTLY_CINDY
        ]
        segments = conversation(*swapped)
        claims = [
            claim("Speaker 2", "Sydney", 1, "It may end up, Sydney, being you and I"),
            claim("Speaker 2", "Cindy", 5, "Thanks Cindy"),
        ]

        assert naming.resolve(claims, segments) == {"Speaker 2": "Sydney"}

    def test_an_even_conflict_leaves_the_number_alone(self):
        segments = conversation(
            "Morning, Cindy.",
            "Morning.",
            "Thanks, Sydney.",
            "Any time.",
        )
        claims = [
            claim("Speaker 2", "Cindy", 1, "Morning, Cindy"),
            claim("Speaker 2", "Sydney", 3, "Thanks, Sydney"),
        ]

        # One each, and the meeting says no more than the claims do. Refusing
        # leaves Speaker 2 visibly unfinished, which is where the user already
        # was; naming them is a fact on the page that nothing distinguishes
        # from a true one.
        assert naming.resolve(claims, segments) == {}

    def test_a_narrow_win_refuses_too(self):
        # Three against two is a transcript disagreeing with itself, not a
        # nickname. The winner has to be distinctly the best, not merely ahead.
        segments = conversation(
            "Morning, Cindy.",
            "Morning.",
            "Cindy, are you ready?",
            "Ready.",
            "Thanks Sydney.",
            "Any time.",
            "Sydney, one more thing.",
            "Go ahead.",
            "Cindy, last one.",
            "Sure.",
        )
        claims = [
            claim("Speaker 2", "Cindy", 1, "Morning, Cindy"),
            claim("Speaker 2", "Sydney", 5, "Thanks Sydney"),
        ]

        assert naming.resolve(claims, segments) == {}

    def test_two_spellings_of_one_name_do_not_split_its_evidence(self):
        # A model that writes the same name two ways used to create two
        # candidates dividing one body of evidence between them -- and a third
        # name that never split could then come top with less support than
        # either half.
        segments = conversation(
            "Morning, Cindy.",
            "Morning.",
            "Cindy, are you ready?",
            "Ready.",
            "Thanks Sydney.",
            "Any time.",
        )
        claims = [
            claim("Speaker 2", "Cindy", 1, "Morning, Cindy"),
            claim("Speaker 2", "cindy", 3, "cindy, are you ready"),
            claim("Speaker 2", "Sydney", 5, "Thanks Sydney"),
        ]

        # One candidate, shown the way a reader expects a name to be spelled.
        assert naming.resolve(claims, segments) == {"Speaker 2": "Cindy"}


class TestWhatCountsAsEvidence:

    def test_repeating_one_claim_cannot_manufacture_support(self):
        # Three claims, one sentence. Evidence is counted per *turn*, so a model
        # that says the same thing three times says it once.
        segments = conversation(
            "Morning, Cindy.",
            "Morning.",
            "Thanks, Sydney.",
            "Any time.",
        )
        claims = [
            claim("Speaker 2", "Cindy", 1, "Morning, Cindy"),
            claim("Speaker 2", "Sydney", 3, "Thanks, Sydney"),
            claim("Speaker 2", "Sydney", 3, "Thanks, Sydney"),
            claim("Speaker 2", "Sydney", 3, "Sydney"),
        ]

        assert naming.resolve(claims, segments) == {}

    def test_one_unverifiable_occurrence_cannot_outrank_several_sound_ones(self):
        # The low-quality occurrence is a fragment too short for anything to
        # have confirmed who spoke it, and the model is insistent about it.
        # Two sound turns still outweigh it.
        segments = conversation(
            "Morning, Cindy.",
            "Morning.",
            "Cindy, can you take this?",
            "Sure.",
            "Sydney?",
            "Yes?",
        )
        segments[4].end = segments[4].start + 0.4      # below the embedder's floor

        claims = [
            claim("Speaker 2", "Cindy", 1, "Morning, Cindy"),
            claim("Speaker 2", "Sydney", 5, "Sydney"),
            claim("Speaker 2", "Sydney", 5, "Sydney"),
            claim("Speaker 2", "Sydney", 5, "Sydney"),
        ]

        assert naming.resolve(claims, segments) == {"Speaker 2": "Cindy"}

    def test_talking_about_somebody_never_names_the_speaker(self):
        # Every occurrence is the grammatical subject of its sentence. Somebody
        # discussed twice is still somebody discussed, and may not be in the
        # room at all.
        segments = conversation(
            "Cindy said she would handle the rollout.",
            "Right.",
            "Cindy mentioned it again yesterday.",
            "Yeah.",
        )
        claims = [
            claim("Speaker 2", "Cindy", 1, "Cindy said she would handle the rollout"),
            claim("Speaker 2", "Cindy", 3, "Cindy mentioned it again yesterday"),
        ]

        assert naming.resolve(claims, segments) == {}

    def test_a_mention_does_not_corroborate_a_genuine_address_either(self):
        # One real vocative for Sydney; two mentions of Cindy, who is being
        # talked about. The mentions must not out-count the address.
        segments = conversation(
            "Cindy said she would handle the rollout.",
            "Right.",
            "Cindy mentioned it again yesterday.",
            "Thanks, Sydney.",
        )
        claims = [
            claim("Speaker 1", "Sydney", 4, "Thanks, Sydney"),
            claim("Speaker 1", "Cindy", 1, "Cindy said she would handle the rollout"),
        ]

        assert naming.resolve(claims, segments) == {"Speaker 1": "Sydney"}

    def test_a_self_introduction_outweighs_a_conflicting_address(self):
        # Required: direct self-introduction remains strong evidence. A person
        # stating their own name outranks somebody else's pronunciation of it.
        segments = conversation(
            "Right, let us go round the room.",
            "Hi, I'm Cindy.",
            "Thanks, Sydney.",
            "No problem.",
        )
        claims = [
            claim("Speaker 2", "Cindy", 2, "I'm Cindy", basis="introduced"),
            claim("Speaker 2", "Sydney", 3, "Thanks, Sydney"),
        ]

        assert naming.resolve(claims, segments) == {"Speaker 2": "Cindy"}

    def test_a_self_introduction_is_not_also_counted_as_being_addressed(self):
        # "Hi, I'm Cindy" contains the name in the same position an address
        # does. Weighing it twice would let one sentence beat two turns.
        segments = conversation(
            "Right, let us go round the room.",
            "Hi, I'm Cindy.",
            "Thanks, Sydney.",
            "No problem.",
            "Sydney, could you start?",
            "Sure.",
        )
        claims = [
            claim("Speaker 2", "Cindy", 2, "I'm Cindy", basis="introduced"),
            claim("Speaker 2", "Sydney", 3, "Thanks, Sydney"),
        ]

        # Introduction 6 against two sound addresses 4: ahead, but not twice
        # ahead, so the honest answer is none.
        assert naming.resolve(claims, segments) == {}


class TestManualNamesAreNeverOverwritten:
    """The precedence, exercised against the strongest possible inference."""

    def test_a_name_a_person_typed_outranks_every_amount_of_evidence(self):
        segments = [
            seg("Speaker 1", "Thanks, Sydney.", 0.0, key="spk_1"),
            seg("Cindy", "Any time.", 4.0, key="spk_2"),
            seg("Speaker 1", "Sydney, can you take this?", 8.0, key="spk_1"),
            seg("Cindy", "Sure.", 12.0, key="spk_2"),
            seg("Speaker 1", "Sydney, one last thing.", 16.0, key="spk_1"),
            seg("Cindy", "Go on.", 20.0, key="spk_2"),
        ]
        claims = [claim("Cindy", "Sydney", 1, "Thanks, Sydney")]

        assert naming.resolve(claims, segments) == {}
        assert "Cindy" not in naming.open_labels(segments)

    def test_apply_refuses_a_typed_name_even_if_asked_directly(self):
        # The guard is re-run at the point of writing, so a bad reading of the
        # dialogue cannot become an overwritten name however it arrives.
        segments = [
            seg("Cindy", "Morning all.", 0.0, key="spk_1"),
            seg("Speaker 2", "Morning.", 4.0, key="spk_2"),
        ]

        assert naming.apply(segments, {"Cindy": "Sydney"}) == []
        assert [segment.speaker for segment in segments] == ["Cindy", "Speaker 2"]

    def test_the_precedence_holds_for_a_name_already_worn_here(self):
        # Somebody is already Cindy in this meeting. Nobody else may be given
        # it, however much the dialogue seems to.
        segments = conversation(
            "Morning, Cindy.",
            "Morning.",
            "Cindy, are you ready?",
            "Ready.",
        )
        segments[1].speaker = segments[3].speaker = "Cindy"
        segments[1].speaker_key = segments[3].speaker_key = "spk_2"

        claims = [claim("Speaker 1", "Cindy", 1, "Morning, Cindy")]

        assert naming.resolve(claims, segments) == {}
