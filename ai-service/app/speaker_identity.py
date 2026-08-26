"""Learning a voice when a user names one, and recognising it later.

The storage and orchestration half of speaker identification. `app.voiceprints`
decides whether a match is allowed; `app.providers.ecapa_embedder` turns audio
into a vector; this module holds the two together and owns the only two tables
that contain voice templates.

## The two operations, and why only one of them writes

**learn** happens when a human renames a speaker to a real name. That rename is
the consent event and the training signal at the same time: it is a person
asserting "this voice is Sarah", about audio they have, in a meeting they own.
It is the *only* thing that creates or updates a profile.

**identify** happens when a human presses "Rematch speakers". It reads profiles
and writes none. This asymmetry is load-bearing. If identification could also
enrol, one confident mistake would be averaged into Sarah's profile, making the
next mistake more likely — a feedback loop that degrades silently and is almost
impossible to notice from the outside, because each individual step looks like
the feature working.

## Consent is checked upstream, and again here

Spring will not call either endpoint for an account with speaker learning
switched off; it owns the `users` row and gates on it. This module does not
trust that on its own — but it also cannot read `users` under row-level
security, so its defence is different in kind: without `SPEAKER_PROFILE_KEY`
there is no cipher, and with no cipher nothing can be written or read at all.
A misconfigured deployment therefore has the feature switched off rather than
switched on and unencrypted, which is the failure worth engineering for.

## What is never logged

No waveform, no embedding, no ciphertext, and no similarity paired with a
person's name at INFO. Counts and speaker keys, which are meeting-local and
meaningless outside it, are all that reaches the log. The reason is narrow and
practical: logs are the copy of your data that ends up somewhere nobody
inventoried, and a voice template in a log file is a voice template outside
every control described in V53.
"""

from __future__ import annotations

import logging
import struct
import uuid
from dataclasses import dataclass
from typing import Sequence

from app.config import Settings
from app.voiceprints import (
    EMBEDDING_DIM,
    Candidate,
    Match,
    Profile,
    Thresholds,
    centroid,
    is_unresolved,
    match_speakers,
)

logger = logging.getLogger("ai-service.speakers")


class SpeakerIdentityUnavailable(RuntimeError):
    """The feature cannot run — no key, no model, no database, or no audio.

    Distinct from "no match found" everywhere it is handled. The user is owed
    different sentences for "we looked and nobody matched" and "we could not
    look", and collapsing the two would make a broken deployment look like a
    working one that never recognises anybody.
    """


@dataclass(frozen=True)
class SpeakerTurns:
    """One canonical speaker in one meeting, as Spring sees it."""

    speaker_key: str
    display_name: str
    spans: list[tuple[float, float]]

    @property
    def seconds(self) -> float:
        return sum(max(0.0, end - start) for start, end in self.spans)


@dataclass(frozen=True)
class IdentifyOutcome:
    matches: list[Match]
    #: How many speakers were eligible to be looked at, for the log line and
    #: for the "we tried, nobody matched" wording.
    considered: int
    profiles_available: int


def _pack(vector: Sequence[float]) -> bytes:
    """A 192-float vector as bytes, before encryption."""
    if len(vector) != EMBEDDING_DIM:
        raise ValueError(f"expected {EMBEDDING_DIM} floats, got {len(vector)}")
    return struct.pack(f"<{EMBEDDING_DIM}f", *(float(v) for v in vector))


def _unpack(raw: bytes) -> list[float]:
    return list(struct.unpack(f"<{EMBEDDING_DIM}f", raw))


class SpeakerIdentityService:
    """Voice templates: stored encrypted, matched in memory, deleted on request."""

    def __init__(self, settings: Settings, rag, embedder=None) -> None:
        # `rag` supplies the pooled, tenant-stamped connection. Sharing it is
        # the established pattern here (see RagService.pool) and it matters more
        # than usual for these tables: one pool means one place where
        # `app.user_id` is set, so there is no second code path that could open
        # a connection without it and read past row-level security.
        self._settings = settings
        self._rag = rag
        self._embedder = embedder
        self._cipher = None
        self._cipher_ready = False

    # --- availability ------------------------------------------------------- #
    @property
    def cipher(self):
        """The Fernet used for embeddings at rest, or None when unconfigured."""
        if self._cipher_ready:
            return self._cipher
        self._cipher_ready = True
        key = (self._settings.speaker_profile_key or "").strip()
        if not key:
            logger.info("SPEAKER_PROFILE_KEY is not set — speaker identification is off.")
            return None
        try:
            from cryptography.fernet import Fernet
        except ImportError:
            # Distinguished from a bad key because the fix is completely
            # different, and "your key is invalid" sends somebody to rotate a
            # key that was fine.
            logger.warning("cryptography is not installed — speaker identification is off.")
            return None
        try:
            self._cipher = Fernet(key.encode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            # The key itself is never echoed, not even truncated.
            logger.warning("SPEAKER_PROFILE_KEY is not a valid Fernet key (%s).", type(exc).__name__)
            self._cipher = None
        return self._cipher

    @property
    def embedder(self):
        if self._embedder is None:
            from app.providers.ecapa_embedder import EcapaEmbedder

            self._embedder = EcapaEmbedder()
        return self._embedder

    def unavailable_reason(self) -> str | None:
        """Why this cannot run, in words a user can act on. None means it can."""
        if self._rag is None or not getattr(self._rag, "enabled", False):
            return "Speaker matching is unavailable: no database connection."
        if self.cipher is None:
            return "Speaker matching is not configured on this server."
        from app.providers.ecapa_embedder import EcapaEmbedder

        if not EcapaEmbedder.installed():
            return "Speaker matching is not installed on this server."
        return None

    def _require(self) -> None:
        reason = self.unavailable_reason()
        if reason:
            raise SpeakerIdentityUnavailable(reason)

    # --- voiceprints -------------------------------------------------------- #
    async def _cached_voiceprints(
        self, user_id: str, meeting_id: str
    ) -> dict[str, tuple[list[float], float]]:
        out: dict[str, tuple[list[float], float]] = {}
        async with self._rag.connection(user_id) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT speaker_key, embedding, speech_seconds "
                    "FROM meeting_speaker_voiceprints WHERE meeting_id = %s",
                    (meeting_id,),
                )
                for key, blob, seconds in await cur.fetchall():
                    try:
                        out[key] = (_unpack(self.cipher.decrypt(bytes(blob))), float(seconds))
                    except Exception:  # noqa: BLE001
                        # Wrong key, or a row from a previous key. Unreadable is
                        # the same as absent: it will simply be recomputed.
                        logger.warning("A stored voiceprint could not be read; ignoring it.")
        return out

    async def _store_voiceprints(
        self, user_id: str, meeting_id: str, prints: dict[str, tuple[list[float], float]]
    ) -> None:
        async with self._rag.connection(user_id) as conn:
            async with conn.cursor() as cur:
                for key, (vector, seconds) in prints.items():
                    await cur.execute(
                        """
                        INSERT INTO meeting_speaker_voiceprints
                            (id, meeting_id, user_id, speaker_key, embedding, speech_seconds)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT (meeting_id, speaker_key)
                        DO UPDATE SET embedding = EXCLUDED.embedding,
                                      speech_seconds = EXCLUDED.speech_seconds
                        """,
                        (
                            "vpr_" + uuid.uuid4().hex,
                            meeting_id,
                            user_id,
                            key,
                            self.cipher.encrypt(_pack(vector)),
                            seconds,
                        ),
                    )
            await conn.commit()

    async def voiceprints_for(
        self,
        user_id: str,
        meeting_id: str,
        speakers: Sequence[SpeakerTurns],
        *,
        object_key: str | None,
        wanted: Sequence[str] | None = None,
    ) -> dict[str, tuple[list[float], float]]:
        """Voiceprints for the named speakers, computing whatever is missing.

        The audio is fetched once for all of them and dropped when this returns.

        Without an ``object_key`` the cache is the whole answer. That used to be
        described here as the case that matters -- "retention deletes recordings
        long before anybody stops wanting to know who was in them" -- and it was
        wrong: erasing a recording also calls ``forget_meeting_voiceprints``, on
        purpose, because a voiceprint is a durable identifier built from that
        person's voice. So after an erasure there is no audio *and* no cache, and
        this returns nothing. ``identify`` is where that is turned into an
        honest answer rather than an empty match list.

        The one state where a cache outlives its audio is a meeting that never
        had an ``object_key`` to begin with. Matching from it is allowed and
        unchanged; nothing here weakens erasure to make it happen.
        """
        self._require()
        cached = await self._cached_voiceprints(user_id, meeting_id)
        needed = [
            s for s in speakers
            if s.speaker_key not in cached and (wanted is None or s.speaker_key in wanted)
        ]
        if not needed:
            return cached

        if not object_key:
            # Nothing to compute from. The cache is the whole answer.
            return cached

        from app.providers.ecapa_embedder import (
            SpeakerEmbeddingUnavailable,
            choose_spans,
            decode_to_pcm,
            take_spans,
        )
        from app.storage import fetch_audio

        try:
            audio, _ = await fetch_audio(self._settings, audio_url=None, object_key=object_key)
            pcm = decode_to_pcm(audio)
            del audio
        except SpeakerEmbeddingUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001
            raise SpeakerIdentityUnavailable(
                "The recording for this meeting could not be read."
            ) from exc

        fresh: dict[str, tuple[list[float], float]] = {}
        for speaker in needed:
            picked = choose_spans(speaker.spans)
            if not picked.spans:
                continue
            try:
                vector = self.embedder.embed(take_spans(pcm, picked.spans))
            except SpeakerEmbeddingUnavailable:
                # One speaker with too little usable audio is not a failure of
                # the request — it is that speaker staying unresolved, which is
                # a correct outcome the matcher would have reached anyway.
                continue
            fresh[speaker.speaker_key] = (vector, picked.seconds)

        if fresh:
            await self._store_voiceprints(user_id, meeting_id, fresh)
            logger.info(
                "Computed %d voiceprint(s) for meeting %s.", len(fresh), meeting_id
            )
        cached.update(fresh)
        return cached

    # --- profiles ----------------------------------------------------------- #
    async def _profiles(self, user_id: str) -> list[Profile]:
        rows: list[Profile] = []
        async with self._rag.connection(user_id) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT id, display_name, embedding, sample_count "
                    "FROM speaker_profiles WHERE user_id = %s",
                    (user_id,),
                )
                for pid, name, blob, samples in await cur.fetchall():
                    try:
                        vector = _unpack(self.cipher.decrypt(bytes(blob)))
                    except Exception:  # noqa: BLE001
                        logger.warning("A speaker profile could not be read; ignoring it.")
                        continue
                    rows.append(Profile(pid, name, vector, int(samples)))
        return rows

    async def learn(
        self,
        user_id: str,
        meeting_id: str,
        speaker: SpeakerTurns,
        *,
        object_key: str | None,
        all_speakers: Sequence[SpeakerTurns],
    ) -> str | None:
        """Record that this voice is called this, because a human said so.

        Returns the profile id, or None when there was not enough usable audio
        to build a template. None is an ordinary outcome, not an error: the
        rename itself has already been applied by Spring and is what the user
        asked for. Learning is the bonus, and a profile built from four seconds
        of one-word answers is worse than no profile, because it will sit in the
        way of a good one later.
        """
        # Before `_require()`, deliberately. Renaming Speaker 3 to Speaker 1 is
        # a merge, not an identification, and deciding that needs no model, no
        # key and no database — so it should not fail differently depending on
        # whether they happen to be present.
        name = speaker.display_name.strip()
        if not name or is_unresolved(name):
            return None
        self._require()

        prints = await self.voiceprints_for(
            user_id, meeting_id, all_speakers,
            object_key=object_key, wanted=[speaker.speaker_key],
        )
        found = prints.get(speaker.speaker_key)
        if not found:
            return None
        vector, seconds = found
        if seconds < Thresholds().min_seconds:
            logger.info(
                "Not enough speech to learn %s in meeting %s; the rename stands.",
                speaker.speaker_key, meeting_id,
            )
            return None

        async with self._rag.connection(user_id) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT id, embedding, sample_count FROM speaker_profiles "
                    "WHERE user_id = %s AND lower(btrim(display_name)) = lower(btrim(%s))",
                    (user_id, name),
                )
                existing = await cur.fetchone()

                if existing is None:
                    profile_id = "spf_" + uuid.uuid4().hex
                    await cur.execute(
                        "INSERT INTO speaker_profiles "
                        "(id, user_id, display_name, embedding, sample_count) "
                        "VALUES (%s, %s, %s, %s, 1)",
                        (profile_id, user_id, name, self.cipher.encrypt(_pack(vector))),
                    )
                else:
                    profile_id, blob, samples = existing
                    try:
                        previous = _unpack(self.cipher.decrypt(bytes(blob)))
                    except Exception:  # noqa: BLE001
                        previous = []
                    # Every appearance counts once, however long they spoke for.
                    # Weighting by duration would let one long meeting pin the
                    # profile to that day's microphone.
                    merged = centroid([*([previous] * int(samples) if previous else []), vector])
                    await cur.execute(
                        "UPDATE speaker_profiles "
                        "SET embedding = %s, sample_count = %s, updated_at = now() "
                        "WHERE id = %s AND user_id = %s",
                        (
                            self.cipher.encrypt(_pack(merged)),
                            int(samples) + 1,
                            profile_id,
                            user_id,
                        ),
                    )
            await conn.commit()

        # The name is the user's own word for their own colleague and is already
        # all over their transcripts; the vector is what must not appear here.
        logger.info("Speaker profile updated from meeting %s.", meeting_id)
        return profile_id

    async def identify(
        self,
        user_id: str,
        meeting_id: str,
        speakers: Sequence[SpeakerTurns],
        *,
        object_key: str | None,
    ) -> IdentifyOutcome:
        """Which unresolved speakers in this meeting are confidently somebody.

        Reads profiles, writes none. Returns proposals for Spring to apply; this
        service never touches a transcript.
        """
        self._require()

        unresolved = [s for s in speakers if is_unresolved(s.display_name)]
        taken = frozenset(
            s.display_name for s in speakers if not is_unresolved(s.display_name)
        )
        profiles = await self._profiles(user_id)
        if not unresolved or not profiles:
            return IdentifyOutcome([], len(unresolved), len(profiles))

        prints = await self.voiceprints_for(
            user_id, meeting_id, speakers,
            object_key=object_key, wanted=[s.speaker_key for s in unresolved],
        )
        candidates = [
            Candidate(s.speaker_key, prints[s.speaker_key][0], prints[s.speaker_key][1])
            for s in unresolved
            if s.speaker_key in prints
        ]

        if not candidates and not object_key:
            # Nothing was compared, and nothing could have been: there is no
            # recording to embed and no voiceprint left over from when there was
            # one. Erasing the audio erases this meeting's voiceprints too, by
            # design, so this is the ordinary state of a meeting whose recording
            # the user has erased -- and it used to fall through to an empty
            # match list, which Spring reports as "No new speaker matches found."
            #
            # That sentence is a claim about the speakers: we listened, and none
            # of them was anybody you know. Here we did not listen. Saying so is
            # the difference between a result and a silence dressed up as one.
            #
            # Only when there is NO audio. With a recording present an empty
            # candidate list means every unresolved speaker had too little
            # speech to embed, which is a real comparison the matcher would have
            # declined anyway -- that stays "no match".

            raise SpeakerIdentityUnavailable(
                "Speaker matching is unavailable for this meeting because its "
                "recording has been deleted."
            )

        matches = match_speakers(
            candidates,
            profiles,
            thresholds=Thresholds(
                accept=self._settings.speaker_match_threshold,
                margin=self._settings.speaker_match_margin,
                min_seconds=self._settings.speaker_min_speech_seconds,
            ),
            taken_names=taken,
        )
        logger.info(
            "Rematch on meeting %s: %d unresolved, %d profile(s), %d matched.",
            meeting_id, len(unresolved), len(profiles), len(matches),
        )
        return IdentifyOutcome(matches, len(unresolved), len(profiles))

    # --- forgetting --------------------------------------------------------- #
    @property
    def storage_available(self) -> bool:
        """Whether a deletion issued right now would actually reach a database.

        The three ``forget`` methods below all return "nothing removed" when it
        is false, and a count of zero is otherwise indistinguishable from "there
        was nothing there" -- so this is what lets the endpoint tell a caller
        whether its deletion is proven or merely unopposed.
        """
        return self._rag is not None and bool(getattr(self._rag, "enabled", False))

    async def forget_everything(self, user_id: str) -> int:
        """Delete every profile and every voiceprint this account holds.

        Called when speaker learning is switched off and when an account is
        closed. Withdrawing consent removes the data, not merely the use of it —
        a switch that only stopped new learning would leave the templates in
        place, which is not what "off" means to the person reading it.
        """
        if not self.storage_available:
            return 0
        async with self._rag.connection(user_id) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "DELETE FROM meeting_speaker_voiceprints WHERE user_id = %s", (user_id,)
                )
                await cur.execute(
                    "DELETE FROM speaker_profiles WHERE user_id = %s", (user_id,)
                )
                removed = cur.rowcount or 0
            await conn.commit()
        logger.info("Deleted %d speaker profile(s) and every voiceprint for one account.", removed)
        return removed

    async def forget_profile(self, user_id: str, profile_id: str) -> bool:
        """Delete one named voice."""
        if not self.storage_available:
            return False
        async with self._rag.connection(user_id) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "DELETE FROM speaker_profiles WHERE id = %s AND user_id = %s",
                    (profile_id, user_id),
                )
                gone = (cur.rowcount or 0) > 0
            await conn.commit()
        return gone

    async def forget_meeting_voiceprints(self, user_id: str, meeting_id: str) -> int:
        """Drop the templates derived from one recording.

        Called when the audio is erased. The vector is not audio and cannot be
        turned back into it, but it is derived from the voice on that recording,
        and answering "delete the recording of me" by keeping a durable
        identifier built from it would be a lie by omission.

        Also called when a speaker is manually corrected, where the reason is
        accuracy rather than privacy: the cached vector for a speaker key is an
        average of the spans that key owned when it was computed, and moving
        spans between keys is exactly the statement that the average was built
        from the wrong audio.

        The count is rows removed, and zero is a perfectly ordinary answer --
        a meeting whose voiceprints were never computed has none to drop. It is
        NOT proof the deletion ran: that is ``storage_available``, which the
        endpoint reports separately, because a caller correcting a speaker needs
        to know the cache is empty rather than merely uncontested.
        """
        if not self.storage_available:
            return 0
        async with self._rag.connection(user_id) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "DELETE FROM meeting_speaker_voiceprints WHERE meeting_id = %s AND user_id = %s",
                    (meeting_id, user_id),
                )
                removed = cur.rowcount or 0
            await conn.commit()
        return removed
