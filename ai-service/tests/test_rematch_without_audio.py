"""Rematch on a meeting whose recording is gone.

There are two outcomes that used to produce the same sentence on screen, and
only one of them is true:

**We compared, and nobody matched.** The unresolved voice was embedded, scored
against every profile the account holds, and cleared none of them. "No new
speaker matches found" is exactly right, and it is the common case.

**We could not compare anything.** The recording was erased, which by design
also erased this meeting's voiceprints — so there is no audio to embed and no
cached vector to fall back on. Nothing was scored against anything. Reporting
that as "no matches found" is a claim about the speakers when the truth is a
fact about the recording, and it sends somebody looking for a better microphone
when what they need to know is that the audio is gone.

These tests pin the boundary between the two. The matcher itself is covered in
`test_speaker_rematch.py`; what is under test here is which answer comes back.
"""

from __future__ import annotations

import pytest

from app.config import Settings
from app.speaker_identity import (
    SpeakerIdentityService,
    SpeakerIdentityUnavailable,
    SpeakerTurns,
)
from app.voiceprints import EMBEDDING_DIM

# Generated for the test suite. Never used anywhere else and not the dev key.
TEST_KEY = "0Xr8vAZ_1kSc0DdyRW5jrTS9LhWoBwvFxbXHkQ4KAcU="

USER = "usr_1"
MEETING = "mtg_1"


def settings(**over) -> Settings:
    base = {"speaker_profile_key": TEST_KEY, "pg_host": "localhost"}
    base.update(over)
    return Settings(**base)


class FakeRag:
    enabled = True


def unit(seed: float) -> list[float]:
    """A normalised vector, well separated from the others.

    Sinusoidal rather than a linear ramp: two ramps that differ only by a
    constant offset point almost the same way — the first draft of this helper
    produced two "different" voices with a cosine of 0.999, which sailed past
    the accept threshold and made a test about *not matching* match.
    """
    import math

    raw = [math.sin(seed * 1.7 + i * 0.37) for i in range(EMBEDDING_DIM)]
    norm = sum(v * v for v in raw) ** 0.5
    return [v / norm for v in raw]


ALICE = unit(1.0)


def service(*, profiles, prints):
    """A SpeakerIdentityService with everything below `identify` stubbed out.

    `prints` is what `voiceprints_for` hands back — the merge of whatever was
    cached and whatever could be computed from the audio. Stubbed at that seam
    on purpose: fetching and embedding are covered by their own tests and need a
    database and a gigabyte of model, while what is under test here is the
    single decision `identify` makes once it knows what it has to compare.
    """
    from app.voiceprints import Profile

    svc = SpeakerIdentityService(settings(), FakeRag())

    async def _profiles(user_id):
        return [
            Profile(profile_id=f"prof_{n}", display_name=n, embedding=v, sample_count=3)
            for n, v in profiles
        ]

    async def _voiceprints_for(user_id, meeting_id, speakers, *, object_key, wanted=None):
        return dict(prints)

    svc._profiles = _profiles
    svc.voiceprints_for = _voiceprints_for
    return svc


def turns(*keys_and_names) -> list[SpeakerTurns]:
    return [
        SpeakerTurns(speaker_key=k, display_name=n, spans=[(0.0, 30.0)])
        for k, n in keys_and_names
    ]


@pytest.fixture(autouse=True)
def _model_is_installed(monkeypatch):
    """Pretend the embedder is present, so it is never the reported reason."""
    from app.providers import ecapa_embedder

    monkeypatch.setattr(ecapa_embedder.EcapaEmbedder, "installed", staticmethod(lambda: True))


# --- the recording is gone --------------------------------------------------- #

async def test_a_deleted_recording_is_unavailable_not_no_match():
    """The case this file exists for.

    Erasing the audio nulls the object key AND deletes the meeting's
    voiceprints. So: unresolved speakers, real profiles to compare them against,
    and nothing whatever to compare.
    """
    svc = service(profiles=[("Alice", ALICE)], prints={})

    with pytest.raises(SpeakerIdentityUnavailable) as raised:
        await svc.identify(USER, MEETING, turns(("spk_1", "Speaker 1")), object_key=None)

    message = str(raised.value)
    # Says which thing is missing, because "unavailable" on its own sends
    # somebody to the settings page to look for a switch that is already on.
    assert "recording" in message.lower()
    assert "deleted" in message.lower()


async def test_the_message_is_about_the_recording_not_the_speakers():
    svc = service(profiles=[("Alice", ALICE)], prints={})

    with pytest.raises(SpeakerIdentityUnavailable) as raised:
        await svc.identify(USER, MEETING, turns(("spk_1", "Speaker 1")), object_key=None)

    # Never the sentence that means "we looked".
    assert "no new speaker matches" not in str(raised.value).lower()


# --- the recording is there -------------------------------------------------- #

async def test_a_present_recording_with_nothing_matching_is_a_normal_result():
    """The other outcome, and it must not have been broken by the fix.

    The audio is there, the voice was embedded, and it scored against Alice
    badly enough to be refused. That is a comparison that happened.
    """
    svc = service(profiles=[("Alice", ALICE)], prints={"spk_1": (unit(9.0), 30.0)})

    outcome = await svc.identify(
        USER, MEETING, turns(("spk_1", "Speaker 1")), object_key="meetings/u/m/a.webm")

    assert outcome.matches == []
    assert outcome.considered == 1
    assert outcome.profiles_available == 1


async def test_too_little_speech_with_audio_present_is_still_no_match():
    """A speaker with no usable span is a refusal, not an outage.

    The recording is there; this speaker simply did not say enough for an
    embedding to mean anything, which is a decision the matcher would have
    reached anyway. Reporting it as "your recording is deleted" would be a lie
    about a file that exists.
    """
    svc = service(profiles=[("Alice", ALICE)], prints={})

    outcome = await svc.identify(
        USER, MEETING, turns(("spk_1", "Speaker 1")), object_key="meetings/u/m/a.webm")

    assert outcome.matches == []
    assert outcome.considered == 1


# --- a cache that outlived its audio ----------------------------------------- #

async def test_a_surviving_voiceprint_is_still_usable_without_a_recording():
    """Allowed, and deliberately unchanged.

    Erasure deletes both, so this is not reachable through the erasure path —
    that behaviour is preserved and no test here weakens it. What this pins is
    that the fix keys off "nothing to compare" rather than off "no object key":
    a meeting that has a usable vector can still be matched from it, and the
    unavailable answer is reserved for having neither.
    """
    svc = service(profiles=[("Alice", ALICE)], prints={"spk_1": (ALICE, 30.0)})

    outcome = await svc.identify(
        USER, MEETING, turns(("spk_1", "Speaker 1")), object_key=None)

    # It ran. Whether it matched is the matcher's business, not this file's.
    assert outcome.considered == 1
    assert outcome.profiles_available == 1


# --- the answers that come before any of this -------------------------------- #

async def test_nothing_unresolved_is_not_an_outage():
    """Every speaker is already named, so there was nothing to look for."""
    svc = service(profiles=[("Alice", ALICE)], prints={})

    outcome = await svc.identify(USER, MEETING, turns(("spk_1", "Priya")), object_key=None)

    assert outcome.matches == []
    assert outcome.considered == 0


async def test_no_profiles_is_not_an_outage_either():
    """An account that has never named anybody has nothing to match against.

    Deliberately reported as an ordinary empty result rather than as
    unavailability, even with the recording deleted: the honest first fact is
    that there are no known voices, and that is true whatever happened to the
    audio.
    """
    svc = service(profiles=[], prints={})

    outcome = await svc.identify(USER, MEETING, turns(("spk_1", "Speaker 1")), object_key=None)

    assert outcome.matches == []
    assert outcome.profiles_available == 0
