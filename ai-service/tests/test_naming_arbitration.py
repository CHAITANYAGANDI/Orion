"""Phase two: the spelling of an already-attributed name.

Phase one decides *whether* a speaker can be named and *who* the name refers to,
using adjacency, direction and the mention rule. Those rules are right for
attribution and wrong for spelling, and the real meeting proved it:

* the correctly-transcribed vocative was **out of reach** — the person addressed
  did not speak again for nearly two minutes, so the strongest evidence for
  their name counted for nothing;
* the two other correct occurrences were **possessives**, which are somebody
  being talked about and are properly refused as attribution evidence;
* the one mistranscription happened to land beside them, so it was the only
  thing phase one could see.

Phase two asks the other question — *how is that person's name spelled?* — where
adjacency and grammar do not apply, and it is confined so that answering it can
never change who anybody is.

## What these tests are guarding

The invariant, above everything: **arbitration may rewrite a spelling, never an
identity.** It iterates the result of attribution, so every speaker it can touch
was already named and every speaker it cannot touch stays exactly as phase one
left them.

And the two ways it could go wrong, both found by measurement rather than
imagined. A high-frequency capitalised token — a product mentioned throughout a
meeting — outranked a real name until the respelling test was added. And every
pair of genuinely similar names is protected by the attributed-elsewhere guard
rather than by that test, which they all pass.
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


def meeting(*lines: tuple[str, str]) -> list[Segment]:
    """`(speaker, text)` pairs, four seconds apart, all soundly owned."""
    return [
        seg(who, text, start=index * 4.0, key=f"spk_{who.split()[-1]}")
        for index, (who, text) in enumerate(lines)
    ]


#: The real shape, with the real names as fixture data only: a correct vocative
#: too far from the speaker to attribute, a mistranscription close enough to
#: attribute, and two correct possessives. Nothing in `app/` knows any of it.
REAL_SHAPE = (
    ("Speaker 1", "So it may end up, Cindy, being you and I on this."),
    ("Speaker 3", "Sure, that works."),
    ("Speaker 1", "Anyway, moving on to the next item."),
    ("Speaker 3", "Right."),
    ("Speaker 1", "I see a couple of head nods. What do you think, Sydney?"),
    ("Speaker 2", "I think we should ship it."),
    ("Speaker 1", "I was going Cindy's direction here."),
    ("Speaker 3", "Yeah."),
    ("Speaker 1", "I figured I would, like to Cindy's comment, keep it simple."),
    ("Speaker 3", "Agreed."),
)


class TestTheRealPattern:

    def test_the_minority_transcription_is_corrected_by_the_meeting(self):
        segments = meeting(*REAL_SHAPE)
        # The only claim the real model returned on this meeting: one vocative,
        # the mistranscribed one, because it is the only occurrence phase one
        # can verify.
        claims = [claim("Speaker 2", "Sydney", 5, "What do you think, Sydney")]

        assert naming.resolve(claims, segments) == {"Speaker 2": "Cindy"}

    def test_phase_one_on_its_own_still_gets_it_wrong(self):
        # The evidence phase one can see, in isolation: one vocative for the
        # wrong spelling and nothing at all for the right one. This is why
        # phase two exists, and it is asserted so that a future change which
        # "fixes" attribution instead is visible here.
        segments = meeting(*REAL_SHAPE)
        turns = naming._speaking(segments)
        runs = naming._runs(turns)

        assert naming._addressed_turns("Cindy", "Speaker 2", turns, runs) == []
        assert len(naming._addressed_turns("Sydney", "Speaker 2", turns, runs)) == 1

    def test_the_correcting_evidence_is_the_whole_meeting(self):
        segments = meeting(*REAL_SHAPE)
        turns = naming._speaking(segments)

        # One vocative nomination plus two possessives corroborating it.
        assert len(naming._occurrence_turns("Cindy", turns)) == 3
        assert len(naming._occurrence_turns("Sydney", turns)) == 1
        assert "cindy" in naming._nominated_spellings("Speaker 2", turns)

    def test_the_same_rule_runs_the_other_way(self):
        # Nothing is hardcoded: exchange the two spellings and the answer
        # exchanges with them.
        swapped = [
            (who, text.replace("Cindy", "TEMP").replace("Sydney", "Cindy")
                      .replace("TEMP", "Sydney"))
            for who, text in REAL_SHAPE
        ]
        claims = [claim("Speaker 2", "Cindy", 5, "What do you think, Cindy")]

        assert naming.resolve(claims, meeting(*swapped)) == {"Speaker 2": "Sydney"}


class TestWhatMayNominateASpelling:

    def test_a_possessive_alone_cannot_nominate(self):
        # Three occurrences of the alternative, all of them somebody being
        # talked about. A possessive is a reference to a person and carries no
        # claim that they are in the room, so it may corroborate a spelling a
        # vocative put forward and may never put one forward itself.
        segments = meeting(
            ("Speaker 1", "Morning, Sydney."),
            ("Speaker 2", "Morning."),
            ("Speaker 1", "I was going Cindy's direction here."),
            ("Speaker 3", "Right."),
            ("Speaker 1", "That was like to Cindy's comment earlier."),
            ("Speaker 3", "Sure."),
            ("Speaker 1", "And Cindy's point still stands."),
            ("Speaker 3", "Yes."),
        )
        claims = [claim("Speaker 2", "Sydney", 1, "Morning, Sydney")]

        turns = naming._speaking(segments)
        assert len(naming._occurrence_turns("Cindy", turns)) == 3   # ahead...
        assert "cindy" not in naming._nominated_spellings("Speaker 2", turns)
        assert naming.resolve(claims, segments) == {"Speaker 2": "Sydney"}

    def test_a_word_in_object_position_is_not_a_vocative(self):
        # "we use Salesforce, which is great" is closed by a comma but is not
        # set off before it -- it is the object of a verb.
        assert naming._vocatives_in("we use Salesforce, which is great") == []
        assert naming._vocatives_in("I talked to Cindy, and she agreed") == []
        assert naming._vocatives_in("Cindy's comment was fair") == []

    def test_a_word_starting_a_sentence_is_not_a_vocative(self):
        # Capitalisation there is automatic and says nothing, and the slot is
        # full of discourse markers no closed list would finish covering.
        assert naming._vocatives_in("Anyway, we should move on.") == []
        assert naming._vocatives_in("However, that is not the point.") == []

    def test_a_name_set_off_on_both_sides_is_a_vocative(self):
        assert naming._vocatives_in("it may end up, Cindy, being you and I") == ["Cindy"]
        assert naming._vocatives_in("What do you think, Sydney?") == ["Sydney"]
        assert naming._vocatives_in("Hi Michael, how are you?") == ["Michael"]
        assert naming._vocatives_in("Thanks, Michelle.") == ["Michelle"]

    def test_pronouns_are_never_names(self):
        # "I" is capitalised in every sentence of English and sits between
        # commas constantly. Before this it was the best-corroborated "name" in
        # the real meeting by a factor of thirteen.
        assert naming._vocatives_in("it may end up being you and I, just picking one") == []
        assert naming._clean_name("I") == ""
        assert naming._clean_name("They") == ""


class TestTheMargin:
    """Reusing the conservative philosophy of `_clear_winner`, not a new one."""

    def rival(self, extra: int):
        """One attributed vocative, and `extra` corroborating turns for a rival."""
        lines = [
            ("Speaker 1", "Morning, Sydney."),
            ("Speaker 2", "Morning."),
            ("Speaker 1", "So it may end up, Cindy, being you and I."),
            ("Speaker 3", "Right."),
        ]
        for index in range(extra):
            lines.append(("Speaker 1", f"That was like to Cindy's point number {index}."))
            lines.append(("Speaker 3", "Sure."))
        return meeting(*lines)

    def test_three_against_one_replaces(self):
        segments = self.rival(2)                       # Cindy 3, Sydney 1
        claims = [claim("Speaker 2", "Sydney", 1, "Morning, Sydney")]

        assert naming.resolve(claims, segments) == {"Speaker 2": "Cindy"}

    def test_two_against_two_does_not(self):
        segments = self.rival(1)                       # Cindy 2
        segments.append(seg("Speaker 1", "Thanks again, Sydney.", 99.0, key="spk_1"))
        claims = [claim("Speaker 2", "Sydney", 1, "Morning, Sydney")]

        assert naming.resolve(claims, segments) == {"Speaker 2": "Sydney"}

    def test_three_against_two_does_not(self):
        segments = self.rival(2)                       # Cindy 3
        segments.append(seg("Speaker 1", "Thanks again, Sydney.", 99.0, key="spk_1"))
        claims = [claim("Speaker 2", "Sydney", 1, "Morning, Sydney")]

        # Ahead, but not clearly ahead. The attributed spelling stands.
        assert naming.resolve(claims, segments) == {"Speaker 2": "Sydney"}


class TestItCannotTouchIdentity:
    """The invariant, from four directions."""

    def test_it_cannot_name_a_speaker_attribution_refused(self):
        # Overwhelming textual evidence for a name, and no verified claim. The
        # speaker keeps their number: arbitration only ever iterates speakers
        # phase one already named.
        segments = meeting(
            ("Speaker 1", "So it may end up, Cindy, being you and I."),
            ("Speaker 3", "Sure."),
            ("Speaker 1", "That was like to Cindy's comment."),
            ("Speaker 3", "Right."),
            ("Speaker 1", "And Cindy's point still stands."),
            ("Speaker 2", "Fine by me."),
        )

        assert naming.resolve([], segments) == {}

    def test_a_manual_name_is_never_arbitrated(self):
        segments = meeting(
            ("Speaker 1", "So it may end up, Cindy, being you and I."),
            ("Speaker 3", "Sure."),
            ("Speaker 1", "That was like to Cindy's comment."),
            ("Speaker 3", "Right."),
            ("Speaker 1", "And Cindy's point stands."),
            ("Sydney", "Fine by me."),
        )
        segments[-1].speaker_key = "spk_2"

        assert naming.resolve([], segments) == {}
        assert "Sydney" not in naming.open_labels(segments)
        # And directly: writing is re-guarded, so it cannot arrive another way.
        assert naming.apply(segments, {"Sydney": "Cindy"}) == []

    def test_a_self_introduction_is_final(self):
        # Required: self-introduction retains the strongest naming authority.
        # Nobody else's pronunciation outranks the person whose name it is.
        segments = meeting(
            ("Speaker 1", "Right, let us go round the room."),
            ("Speaker 2", "Hi, I'm Sydney."),
            ("Speaker 1", "So it may end up, Cindy, being you and I."),
            ("Speaker 3", "Sure."),
            ("Speaker 1", "That was like to Cindy's comment."),
            ("Speaker 3", "Right."),
            ("Speaker 1", "And Cindy's point stands."),
            ("Speaker 3", "Yes."),
        )
        claims = [claim("Speaker 2", "Sydney", 2, "I'm Sydney", basis="introduced")]

        assert naming.resolve(claims, segments) == {"Speaker 2": "Sydney"}

    def test_a_frequently_mentioned_product_cannot_take_a_name(self):
        # Measured, not imagined: on the real meeting a chat tool was the
        # best-corroborated capitalised token competing for a speaker, and it
        # won until the respelling test was added.
        segments = meeting(
            ("Speaker 1", "Morning, Sydney."),
            ("Speaker 2", "Morning."),
            ("Speaker 1", "Where does it go? Okay, Slack, then."),
            ("Speaker 3", "Slack works for me."),
            ("Speaker 1", "Everything ends up in Slack anyway."),
            ("Speaker 3", "Slack it is."),
        )
        claims = [claim("Speaker 2", "Sydney", 1, "Morning, Sydney")]

        turns = naming._speaking(segments)
        assert len(naming._occurrence_turns("Slack", turns)) > \
            len(naming._occurrence_turns("Sydney", turns))
        assert naming.resolve(claims, segments) == {"Speaker 2": "Sydney"}


class TestTwoRealPeopleWithSimilarNames:
    """Guard 1 does this work, and these tests say so explicitly.

    Every pair below *passes* the respelling test — they are near-identical
    strings, which is the point of choosing them. What keeps them apart is that
    both are attributed, and a name already attributed to another canonical
    speaker is not eligible to replace anybody's spelling.
    """

    def both_named(self, one: str, other: str) -> list[Segment]:
        return meeting(
            ("Speaker 1", f"Hi {one}, how are you?"),
            ("Speaker 2", "Good thanks."),
            ("Speaker 1", f"Thanks, {other}."),
            ("Speaker 3", "No problem."),
            ("Speaker 1", f"I was going {other}'s direction here."),
            ("Speaker 3", "Right."),
            ("Speaker 1", f"That was like to {other}'s comment."),
            ("Speaker 3", "Yes."),
        )

    def claims_for(self, one: str, other: str):
        return [
            claim("Speaker 2", one, 1, f"Hi {one}, how are you"),
            claim("Speaker 3", other, 3, f"Thanks, {other}"),
        ]

    def test_michael_and_michelle_stay_two_people(self):
        segments = self.both_named("Michael", "Michelle")

        # The better-corroborated name does not win, because it belongs to
        # somebody else in this meeting.
        turns = naming._speaking(segments)
        assert len(naming._occurrence_turns("Michelle", turns)) == 3
        assert len(naming._occurrence_turns("Michael", turns)) == 1
        assert naming._one_name_two_spellings("Michael", "Michelle") is True

        assert naming.resolve(self.claims_for("Michael", "Michelle"), segments) == {
            "Speaker 2": "Michael", "Speaker 3": "Michelle",
        }

    def test_brian_and_bryan_stay_two_people(self):
        segments = self.both_named("Brian", "Bryan")

        assert naming._one_name_two_spellings("Brian", "Bryan") is True
        assert naming.resolve(self.claims_for("Brian", "Bryan"), segments) == {
            "Speaker 2": "Brian", "Speaker 3": "Bryan",
        }

    def test_cindy_and_sandy_stay_two_people(self):
        segments = self.both_named("Cindy", "Sandy")

        assert naming._one_name_two_spellings("Cindy", "Sandy") is True
        assert naming.resolve(self.claims_for("Cindy", "Sandy"), segments) == {
            "Speaker 2": "Cindy", "Speaker 3": "Sandy",
        }

    def test_a_name_a_person_typed_is_also_ineligible_as_a_rival(self):
        # Somebody is already Cindy here, by hand. The guard is the same one.
        segments = meeting(
            ("Speaker 1", "Morning, Sydney."),
            ("Speaker 2", "Morning."),
            ("Speaker 1", "So it may end up, Cindy, being you and I."),
            ("Cindy", "Fine by me."),
            ("Speaker 1", "That was like to Cindy's comment."),
            ("Cindy", "Right."),
        )
        segments[3].speaker_key = segments[5].speaker_key = "spk_9"
        claims = [claim("Speaker 2", "Sydney", 1, "Morning, Sydney")]

        assert naming.resolve(claims, segments) == {"Speaker 2": "Sydney"}


class TestTheRespellingTest:
    """Necessary, never sufficient, and not what protects two real people."""

    def test_transposed_consonants_are_one_name(self):
        assert naming._one_name_two_spellings("Cindy", "Sydney") is True

    def test_an_unrelated_word_is_not(self):
        assert naming._one_name_two_spellings("Sydney", "Slack") is False
        assert naming._one_name_two_spellings("Sydney", "Brian") is False
        assert naming._one_name_two_spellings("Michael", "Salesforce") is False

    def test_it_is_symmetric(self):
        for one, other in (("Cindy", "Sydney"), ("Sydney", "Slack")):
            assert naming._one_name_two_spellings(one, other) == \
                naming._one_name_two_spellings(other, one)

    def test_a_name_with_no_consonants_never_matches(self):
        assert naming._one_name_two_spellings("Aoi", "Sydney") is False
