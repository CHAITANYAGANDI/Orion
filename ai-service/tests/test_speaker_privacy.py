"""Voice templates at rest, in logs, and on the way out.

`test_speaker_rematch.py` covers when a match is allowed to happen. This covers
the data that makes matching possible at all, which is the part that needs a
justification rather than a design: a 192-number ECAPA embedding is a stable
identifier derived from a person's body, it is the specific thing that makes one
recording of them linkable to every other, and under GDPR Article 9 a template
used to identify a natural person is biometric data whether or not it can be
turned back into audio.

Recallix held a `known_speakers` table for a year that stored a name, a use
count and a date. That table could not have identified anybody, and its removal
in V51 is why this feature needed new storage rather than a new query. The
storage exists now, so these are the properties it has to have.

Four things are pinned here:

**Fail-closed.** No key means the feature is off, not on and unencrypted. A
deployment that forgot the variable must end up with no capability, because the
other failure mode is biometric-adjacent data sitting in a database in the clear
because somebody missed a line in a compose file.

**Encrypted at rest.** The stored bytes are ciphertext, and they are not the
vector with a different label on it.

**Never logged.** Logs are the copy of your data that ends up somewhere nobody
inventoried. A voice template in a log file is a voice template outside every
control in V53.

**Deletable.** Including from a running service that has lost its model, its key
or its database — a request to remove biometric data is the worst possible place
to be fussy about preconditions.
"""

from __future__ import annotations

import logging
import struct

import pytest

from app.config import Settings
from app.speaker_identity import (
    SpeakerIdentityService,
    SpeakerIdentityUnavailable,
    SpeakerTurns,
    _pack,
    _unpack,
)
from app.voiceprints import EMBEDDING_DIM

VECTOR = [i / 1000.0 for i in range(EMBEDDING_DIM)]

# Generated for the test suite. Never used anywhere else and not the dev key.
TEST_KEY = "0Xr8vAZ_1kSc0DdyRW5jrTS9LhWoBwvFxbXHkQ4KAcU="


def settings(**over) -> Settings:
    base = {"speaker_profile_key": TEST_KEY, "pg_host": "localhost"}
    base.update(over)
    return Settings(**base)


class FakeRag:
    """Just enough of RagService to answer `enabled`."""

    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled


# --- fail closed --------------------------------------------------------------- #
def test_without_a_key_the_feature_is_off_rather_than_unencrypted():
    service = SpeakerIdentityService(settings(speaker_profile_key=None), FakeRag())

    assert service.cipher is None
    assert service.unavailable_reason() is not None
    # And nothing can be written or read, so a misconfigured deployment cannot
    # accumulate plaintext templates while looking like it is working.
    with pytest.raises(SpeakerIdentityUnavailable):
        service._require()


def test_a_malformed_key_is_the_same_as_no_key():
    service = SpeakerIdentityService(settings(speaker_profile_key="not-a-fernet-key"), FakeRag())

    assert service.cipher is None
    assert service.unavailable_reason() is not None


def test_the_key_is_never_echoed_when_it_is_rejected(caplog):
    with caplog.at_level(logging.DEBUG):
        SpeakerIdentityService(settings(speaker_profile_key="sekrit-but-invalid"), FakeRag()).cipher

    # A key in a log line is a key in whatever the logs are shipped to.
    assert "sekrit" not in caplog.text


def test_no_database_means_unavailable_rather_than_a_silent_no_match():
    service = SpeakerIdentityService(settings(), FakeRag(enabled=False))

    reason = service.unavailable_reason()
    assert reason is not None
    # The user is owed different sentences for "we looked and nobody matched"
    # and "we could not look". Collapsing them makes a broken deployment look
    # like a working one that never recognises anybody.
    assert "unavailable" in reason.lower()


# --- encrypted at rest --------------------------------------------------------- #
def test_a_vector_survives_a_round_trip_exactly_enough():
    packed = _pack(VECTOR)
    assert len(packed) == EMBEDDING_DIM * 4  # float32, the model's own precision

    restored = _unpack(packed)
    assert restored == pytest.approx(VECTOR, abs=1e-6)


def test_a_wrong_width_is_refused_rather_than_truncated():
    # A model swap that changed the embedding width. Failing loudly beats
    # writing a truncated vector that still compares to something.
    with pytest.raises(ValueError):
        _pack([1.0, 2.0, 3.0])


def test_what_is_stored_is_ciphertext_and_not_the_vector():
    service = SpeakerIdentityService(settings(), FakeRag())
    stored = service.cipher.encrypt(_pack(VECTOR))

    # Not the packed bytes, and not something a float reader can walk.
    assert stored != _pack(VECTOR)
    assert struct.pack("<f", VECTOR[7]) not in stored
    assert _unpack(service.cipher.decrypt(stored)) == pytest.approx(VECTOR, abs=1e-6)


def test_a_row_written_under_another_key_is_unreadable_rather_than_wrong():
    other = SpeakerIdentityService(
        settings(speaker_profile_key="Aq8Yy5nJ2vKZ7hQx3TgW9pL4sRcVbNmE1dFuHoIjKlM="), FakeRag())
    ours = SpeakerIdentityService(settings(), FakeRag())

    sealed = other.cipher.encrypt(_pack(VECTOR))

    # Fernet is authenticated, so a wrong key raises rather than returning
    # plausible garbage that would then be compared against real voices.
    from cryptography.fernet import InvalidToken

    with pytest.raises(InvalidToken):
        ours.cipher.decrypt(sealed)


# --- never logged -------------------------------------------------------------- #
def test_no_module_in_the_speaker_path_logs_a_vector_or_a_waveform():
    """Checked by reading the source, because this is a rule about every line.

    A test that exercised one code path would pass while a new log statement on
    another leaked the thing this rule exists to protect. The formatting
    arguments of every logger call in these three modules are inspected instead.
    """
    import ast
    import app.providers.ecapa_embedder as embedder
    import app.speaker_identity as identity
    import app.voiceprints as voiceprints

    leaky = {"embedding", "vector", "waveform", "pcm", "audio", "signal",
             "blob", "sealed", "key", "cipher"}

    for module in (identity, embedder, voiceprints):
        tree = ast.parse(open(module.__file__, encoding="utf-8").read())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not isinstance(func, ast.Attribute):
                continue
            if func.attr not in {"debug", "info", "warning", "error", "exception", "critical"}:
                continue
            for arg in node.args[1:]:
                for name in ast.walk(arg):
                    if isinstance(name, ast.Name):
                        assert name.id not in leaky, (
                            f"{module.__name__} logs `{name.id}`"
                        )
                    if isinstance(name, ast.Attribute):
                        assert name.attr not in leaky, (
                            f"{module.__name__} logs `.{name.attr}`"
                        )


def test_learning_logs_the_meeting_and_not_the_person_or_the_vector(caplog):
    """The name is the user's own word for their own colleague.

    It is already on every turn of the transcript, so keeping it out of the log
    would be theatre. The embedding is the thing that must not be there.
    """
    import app.speaker_identity as identity

    source = open(identity.__file__, encoding="utf-8").read()
    assert "Speaker profile updated from meeting %s." in source
    assert "%s is called %s" not in source


# --- deletable ----------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_deletion_does_not_require_a_model_or_a_key():
    """A service with nothing configured still answers a deletion request.

    Deletion has to be as close to unconditional as the code can make it. Being
    fussy about preconditions here is how a request to remove biometric data
    fails softly because an unrelated dependency is missing.
    """
    service = SpeakerIdentityService(settings(speaker_profile_key=None), FakeRag(enabled=False))

    assert await service.forget_everything("usr_1") == 0
    assert await service.forget_profile("usr_1", "spf_1") is False
    assert await service.forget_meeting_voiceprints("usr_1", "mtg_1") == 0


@pytest.mark.asyncio
async def test_learning_refuses_a_placeholder_name():
    """Renaming Speaker 3 to Speaker 1 is a merge, not an identification.

    Enrolling on it would create a profile called "Speaker 1" that would then be
    offered to every future meeting, which is the feature actively making things
    worse.
    """
    service = SpeakerIdentityService(settings(), FakeRag())

    result = await service.learn(
        "usr_1", "mtg_1",
        SpeakerTurns("spk_2", "Speaker 1", [(0.0, 30.0)]),
        object_key="k", all_speakers=[],
    )
    assert result is None


@pytest.mark.asyncio
async def test_identification_never_writes_a_profile():
    """Structural: the read path issues no write, by SQL or by helper.

    If identification could also enrol, one confident mistake would be averaged
    into that person's template and make the next mistake likelier — a loop that
    degrades silently, because every individual step looks like it is working.

    This used to look for the bare words INSERT, UPDATE and DELETE anywhere in
    the source. That caught English as readily as SQL: the method now has to
    tell a user their *recording has been deleted*, and a comment explaining why
    tripped it too. Matching whole statements instead is narrower against prose
    and strictly wider against code — a lowercase `delete from` was invisible to
    the old check and is not to this one — and the second assertion closes the
    hole both versions had, which is a write made through a helper rather than
    inline.
    """
    import inspect
    import re

    source = inspect.getsource(SpeakerIdentityService.identify)

    statements = re.compile(
        r"\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|UPSERT|ON\s+CONFLICT)\b",
        re.IGNORECASE | re.DOTALL,
    )
    found = statements.search(source)
    assert found is None, f"identify() contains a write statement: {found.group(0)!r}"

    # And nothing that writes on its behalf. `voiceprints_for` is the deliberate
    # exception: it caches what it computed from audio it was going to read
    # anyway, which is not a profile and not an identification decision.
    for helper in ("_store_voiceprints", "_store_profile", "forget_", "commit("):
        assert helper not in source, helper
