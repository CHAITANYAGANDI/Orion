"""Telling "there was nothing to delete" apart from "nothing was deleted".

The forget endpoint answers with a count, and for most callers that is enough:
erasing a recording and closing an account both delete because the user asked
them to, and neither has to prove it before doing something else.

One caller does. Correcting a speaker changes which audio belongs to which
speaker key, which is exactly the statement that this meeting's cached
voiceprints — averages of the spans each key owned when they were computed — are
now built from the wrong audio. Spring drops them before saving the correction,
and must not save it unless the drop happened. `deleted: 0` cannot support that
decision: it is the honest answer both for a meeting that had nothing cached and
for a service with no database behind it, and only one of those means the cache
is empty.

So the response carries `confirmed`, which is true only when a DELETE really ran
and committed. These tests pin what it says in each of those states, and that
deletion itself stayed exactly as unconditional as it was.
"""

from __future__ import annotations

import pytest

from app.config import Settings
from app.routers.ai import forget_speakers
from app.schemas import SpeakerForgetRequest, SpeakerForgetResponse
from app.speaker_identity import SpeakerIdentityService

# Generated for the test suite. Never used anywhere else and not the dev key.
TEST_KEY = "0Xr8vAZ_1kSc0DdyRW5jrTS9LhWoBwvFxbXHkQ4KAcU="

USER = "usr_1"
MEETING = "mtg_1"


def settings(**over) -> Settings:
    base = {"speaker_profile_key": TEST_KEY, "pg_host": "localhost"}
    base.update(over)
    return Settings(**base)


class _Cursor:
    """Counts what it was asked to do, and how many rows it claims went."""

    def __init__(self, rowcount: int, fails: bool = False) -> None:
        self.rowcount = rowcount
        self.statements: list[str] = []
        self._fails = fails

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, sql, params=None):
        if self._fails:
            raise RuntimeError("connection lost mid-statement")
        self.statements.append(" ".join(sql.split()))


class _Conn:
    def __init__(self, cursor: _Cursor) -> None:
        self._cursor = cursor
        self.commits = 0

    def cursor(self):
        return self._cursor

    async def commit(self):
        self.commits += 1


def service(*, storage: bool, rowcount: int = 0, fails: bool = False, key: str | None = TEST_KEY):
    """A service whose storage is present, absent, or present and broken."""
    svc = SpeakerIdentityService(
        settings(speaker_profile_key=key), None if not storage else object()
    )
    if not storage:
        return svc, None

    cursor = _Cursor(rowcount, fails)
    conn = _Conn(cursor)

    class _Ctx:
        async def __aenter__(self):
            return conn

        async def __aexit__(self, *exc):
            return False

    class _Rag:
        enabled = True

        def connection(self, user_id=None):
            return _Ctx()

    svc._rag = _Rag()
    return svc, conn


async def forget(svc, **kwargs) -> SpeakerForgetResponse:
    return await forget_speakers(SpeakerForgetRequest(user_id=USER, **kwargs), svc)


# --- what the flag means ----------------------------------------------------- #

async def test_a_real_deletion_is_confirmed():
    svc, conn = service(storage=True, rowcount=3)

    answer = await forget(svc, meeting_id=MEETING)

    assert answer.deleted == 3
    assert answer.confirmed is True
    assert conn.commits == 1


async def test_deleting_nothing_is_still_confirmed():
    """The distinction the whole field exists for, from the good side.

    A meeting that was never rematched has no cached voiceprints, so a correct
    deletion removes zero rows — and the caller's requirement is met, because
    there is no stale vector. Treating zero as failure would refuse every
    correction on every meeting nobody had run Rematch on.
    """
    svc, conn = service(storage=True, rowcount=0)

    answer = await forget(svc, meeting_id=MEETING)

    assert answer.deleted == 0
    assert answer.confirmed is True
    assert conn.commits == 1


async def test_without_storage_the_same_zero_is_not_confirmed():
    """And from the bad side, which is the identical number.

    No pool means no DELETE ran. The endpoint still answers 200 — deletion never
    refuses to be asked — but it no longer implies something happened.
    """
    svc, _ = service(storage=False)

    answer = await forget(svc, meeting_id=MEETING)

    assert answer.deleted == 0
    assert answer.confirmed is False


async def test_a_database_failure_is_not_a_cheerful_zero():
    """The third outcome: it raises, and the caller sees a 5xx.

    Never a 200 with `deleted: 0`, which is the shape that would let Spring save
    a correction over voiceprints that are still sitting there.
    """
    svc, _ = service(storage=True, fails=True)

    with pytest.raises(RuntimeError):
        await forget(svc, meeting_id=MEETING)


# --- the other two branches carry it too ------------------------------------- #

async def test_deleting_one_profile_reports_confirmation():
    svc, _ = service(storage=True, rowcount=1)

    answer = await forget(svc, profile_id="spf_1")

    assert answer.deleted == 1
    assert answer.confirmed is True


async def test_forgetting_everything_reports_confirmation():
    svc, _ = service(storage=True, rowcount=2)

    answer = await forget(svc)

    assert answer.confirmed is True


async def test_without_storage_no_branch_claims_confirmation():
    svc, _ = service(storage=False)

    assert (await forget(svc, profile_id="spf_1")).confirmed is False
    assert (await forget(svc)).confirmed is False


# --- and it fails closed ----------------------------------------------------- #

def test_a_response_that_says_nothing_means_unconfirmed():
    """The default is the safe reading.

    A caller that must know a deletion happened has to treat silence as "it did
    not" — an ai-service too old to send the field is one that cannot tell
    anybody what it deleted.
    """
    assert SpeakerForgetResponse().confirmed is False
    assert SpeakerForgetResponse(deleted=9).confirmed is False


def test_storage_available_is_what_the_forget_methods_short_circuit_on():
    """One predicate, so the answer and the behaviour cannot drift apart.

    If a forget method returned zero on a condition the flag did not know
    about, the endpoint would confirm a deletion that never ran.
    """
    off, _ = service(storage=False)
    on, _ = service(storage=True)

    assert off.storage_available is False
    assert on.storage_available is True


# --- deletion is still unconditional ----------------------------------------- #

async def test_a_missing_key_does_not_stop_a_deletion():
    """Unchanged, and worth re-pinning next to a change about refusing.

    A service with no encryption key can neither read nor write a template, and
    is still expected to delete one. Being fussy about preconditions is how a
    request to remove biometric data fails softly.
    """
    svc, conn = service(storage=True, rowcount=1, key=None)
    assert svc.cipher is None

    answer = await forget(svc, meeting_id=MEETING)

    assert answer.deleted == 1
    assert answer.confirmed is True


async def test_the_meeting_delete_is_scoped_to_one_meeting_and_one_user():
    svc, conn = service(storage=True, rowcount=1)

    await forget(svc, meeting_id=MEETING)

    statement = conn._cursor.statements[0]
    # Voiceprints only. A correction says a voice was in the wrong place, not
    # that the account should forget who anyone is.
    assert "DELETE FROM meeting_speaker_voiceprints" in statement
    assert "speaker_profiles" not in statement
    assert "meeting_id = %s" in statement and "user_id = %s" in statement
