"""Turning a recording into an MP3, once.

Orion stores whatever the uploader produced: webm/opus from a browser's
MediaRecorder, m4a from a phone, wav from a desk recorder, occasionally mp4
with a video track nobody wants. "Export as MP3" has exactly one honest
implementation, which is to decode that and encode MP3 — renaming the file
would produce something every player rejects and some players play as noise,
under a name that promises otherwise.

<h2>Why the conversion lives in this service</h2>

ffmpeg is already installed here, for speaker embedding, and it is the only
thing in the stack that reads every container Orion accepts. Spring has neither,
and giving it either would mean a second codec dependency in a second image to
patch. More importantly the bytes must not go through Spring's heap: an hour of
audio is tens to hundreds of megabytes, and reading one into a request thread
would hand any logged-in account a way to exhaust the API by clicking Export.

Here the file goes storage → disk → ffmpeg → disk → storage. It is never held
in memory in full, by boto3 (which streams and chunks both directions) or by
this module.

<h2>Why disk and not a pipe</h2>

`ecapa_embedder.decode_to_pcm` pipes audio through ffmpeg's stdin, and that is
right for it: it decodes short spans and never sees a container that needs
seeking. This cannot. An m4a or mp4 written by an iPhone puts its moov atom at
the end of the file, and ffmpeg reading such a file from a pipe fails outright
with "moov atom not found" — for the single most common non-browser upload
Orion receives. A temporary file is seekable, so every format works.

<h2>State</h2>

There is no database. The derivative's key is derived from the source key, so
the object store is the record of what has been converted (see
`AudioDerivatives` on the Spring side). What is held here is only what an object
store cannot express: which conversions are running right now, and which one
just failed and why. Both are per-process, both are lost on restart, and losing
them costs at most one repeated conversion.
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import tempfile
from dataclasses import dataclass
from typing import Callable

from app.config import Settings

logger = logging.getLogger("ai-service.transcode")

READY = "ready"
RUNNING = "running"
FAILED = "failed"

#: What a caller is told when something went wrong that is not worth naming.
#: ffmpeg's stderr can contain the object key and the container's internals; it
#: goes to this service's log, and the user gets a sentence they can act on.
GENERIC_FAILURE = "The audio could not be converted. Try again in a moment."


class TranscodeError(Exception):
    """A conversion failed for a reason worth repeating to the user."""


@dataclass(frozen=True)
class TranscodeState:
    """Where one conversion has got to.

    `running` is not an error and must never be rendered as one. `failed` is,
    and carries a sentence rather than a status code.
    """

    status: str
    message: str | None = None


def ffmpeg_command(source: str, target: str) -> list[str]:
    """The conversion, as an argument list.

    Separate from the call so a test can assert the codec without an encoder
    installed — the one thing here that must not drift is `libmp3lame`, because
    every other mistake in this file produces no file at all and that one
    produces a file with the wrong contents and the right name.

    * `-vn` drops the video stream a webm or mp4 upload may carry. Encoding it
      to nothing wastes time; leaving it in would produce a file that is not an
      MP3 in a container that cannot hold it.
    * `-q:a 4` is LAME's variable-bitrate setting, around 165 kbps for stereo
      and well under that for the mono a phone records. Constant 128 kbps would
      spend the same bits on silence as on speech, and meetings are mostly the
      former.
    * No `-ar`. libmp3lame declares the sample rates it supports and ffmpeg
      resamples to the nearest one on its own; naming one here would resample
      files that did not need it.
    * `-y` because the target is a fresh temporary path, and a prompt on a
      service with no terminal is a hang.
    """
    return [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-y",
        "-i", source,
        "-vn",
        "-c:a", "libmp3lame",
        "-q:a", "4",
        target,
    ]


class Mp3Transcoder:
    """Makes sure an MP3 copy of an object exists, without making two.

    Deliberately not a queue. The work is triggered by somebody waiting for it,
    at most one conversion runs per recording, and the answer to "is it done" is
    a HEAD against the bucket — so there is nothing to persist, nothing to
    reconcile after a restart, and no worker to keep alive.
    """

    def __init__(
        self,
        settings: Settings,
        *,
        convert: Callable[[str, str], None] | None = None,
        exists: Callable[[str], bool] | None = None,
    ) -> None:
        self._settings = settings
        # Injectable so the tests exercise the state machine — which is where
        # the concurrency bugs live — without an encoder or an object store.
        self._convert = convert or self._convert_via_ffmpeg
        self._exists = exists or self._exists_in_storage
        self._running: set[str] = set()
        self._failures: dict[str, str] = {}
        #: Strong references to the background tasks. Without them asyncio is
        #: entitled to garbage-collect a running task mid-conversion, which
        #: happens rarely and looks exactly like a conversion that silently
        #: never finished.
        self._tasks: set[asyncio.Task[None]] = set()

    async def ensure(self, object_key: str, target_key: str) -> TranscodeState:
        """Return the state of this conversion, starting it if it is not going.

        Safe to call repeatedly, which is what makes the polling endpoint above
        it safe: the caller asks the same question every two seconds and only
        the first one does any work.
        """
        if not object_key or not target_key:
            return TranscodeState(FAILED, GENERIC_FAILURE)

        if target_key in self._running:
            return TranscodeState(RUNNING)

        # Reported once, then forgotten. Holding the failure would mean a user
        # pressing "Try again" gets the previous failure back instantly without
        # anything being retried; clearing it immediately would mean the poll
        # that should have shown the error starts a second doomed conversion
        # instead. Once, then gone, is the only version where both work.
        failure = self._failures.pop(target_key, None)
        if failure:
            return TranscodeState(FAILED, failure)

        # Claimed before the first await. A second request arriving while this
        # one is still asking the bucket sees `running` and starts nothing --
        # one poll later than ideal, and never a duplicate conversion. The
        # opposite ordering has a window in which two requests both find the
        # object absent and both start encoding it.
        self._running.add(target_key)
        try:
            if await asyncio.to_thread(self._exists, target_key):
                # Somebody already made it -- another instance, or an earlier
                # conversion whose caller went away.
                self._running.discard(target_key)
                return TranscodeState(READY)
        except Exception:
            self._running.discard(target_key)
            logger.exception("Could not check for the converted copy of %s.", object_key)
            return TranscodeState(FAILED, GENERIC_FAILURE)

        task = asyncio.create_task(self._run(object_key, target_key))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return TranscodeState(RUNNING)

    async def _run(self, object_key: str, target_key: str) -> None:
        """The conversion, off the event loop and off the request."""
        try:
            await asyncio.to_thread(self._convert, object_key, target_key)
            logger.info("Converted a recording to mp3.")
        except TranscodeError as exc:
            logger.warning("Conversion failed: %s", exc)
            self._failures[target_key] = str(exc)
        except Exception:
            # The traceback belongs in this log and nowhere near a user.
            logger.exception("Conversion of %s raised.", object_key)
            self._failures[target_key] = GENERIC_FAILURE
        finally:
            self._running.discard(target_key)

    # ---------------------------------------------------------------- storage

    def _client(self):
        import boto3

        return boto3.client(
            "s3",
            endpoint_url=self._settings.s3_endpoint,
            aws_access_key_id=self._settings.s3_access_key,
            aws_secret_access_key=self._settings.s3_secret_key,
            region_name=self._settings.s3_region,
        )

    def _exists_in_storage(self, object_key: str) -> bool:
        """Whether the converted copy is already in the bucket.

        Only a definite "not there" answers False. Anything else -- bad
        credentials, an unreachable endpoint, a 500 from the store -- is raised,
        because the caller reads False as permission to start converting, and
        an hour of CPU spent on a file that has nowhere to be uploaded is worse
        than saying so now. That distinction is the whole reason this is not a
        blanket `except`.
        """
        client = self._client()
        try:
            client.head_object(Bucket=self._settings.s3_bucket, Key=object_key)
            return True
        except Exception as exc:  # noqa: BLE001 - botocore raises a wide range
            status = (
                getattr(exc, "response", None) or {}
            ).get("ResponseMetadata", {}).get("HTTPStatusCode")
            # 403 as well as 404: S3 answers a HEAD for a missing object with
            # 403 when the token cannot list the bucket, and R2 follows it.
            # Either way the object is not there to be served.
            if status in (403, 404):
                return False
            raise

    def _convert_via_ffmpeg(self, object_key: str, target_key: str) -> None:
        """Storage → disk → ffmpeg → disk → storage.

        The temporary directory is removed whichever way this exits, including
        a failed encode: a service that leaks a copy of every recording it could
        not convert into /tmp is a privacy problem that only shows up when the
        disk fills.
        """
        client = self._client()
        bucket = self._settings.s3_bucket

        size = self._source_size(client, bucket, object_key)
        limit = self._settings.transcode_max_bytes
        if size is not None and size > limit:
            raise TranscodeError(
                "This recording is too large to convert. "
                "Export it in its original format instead."
            )

        with tempfile.TemporaryDirectory(prefix="orion-mp3-") as work:
            source = os.path.join(work, "source" + _extension(object_key))
            target = os.path.join(work, "converted.mp3")
            try:
                # download_file streams in parts; the whole recording is never
                # in this process's memory.
                client.download_file(bucket, object_key, source)
            except Exception as exc:  # noqa: BLE001
                raise TranscodeError(
                    "The recording could not be read from storage."
                ) from exc

            run_ffmpeg(source, target, timeout=self._settings.transcode_timeout_seconds)

            try:
                client.upload_file(
                    target, bucket, target_key,
                    ExtraArgs={"ContentType": "audio/mpeg"},
                )
            except Exception as exc:  # noqa: BLE001
                raise TranscodeError(
                    "The converted audio could not be saved. Try again in a moment."
                ) from exc

    @staticmethod
    def _source_size(client, bucket: str, object_key: str) -> int | None:
        try:
            return int(client.head_object(Bucket=bucket, Key=object_key)["ContentLength"])
        except Exception:  # noqa: BLE001
            # Unknown size is not a refusal. The encode has its own timeout and
            # the temporary directory is bounded by the disk; guessing "too big"
            # from a failed HEAD would refuse recordings that convert fine.
            return None


def run_ffmpeg(source: str, target: str, *, timeout: float) -> None:
    """Encode, or raise something a person can read."""
    try:
        completed = subprocess.run(
            ffmpeg_command(source, target),
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:  # pragma: no cover - deployment fault
        raise TranscodeError(
            "MP3 export is not available on this deployment."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise TranscodeError(
            "Converting this recording took too long. "
            "Export it in its original format instead."
        ) from exc

    if completed.returncode != 0:
        # stderr names the file and its internals; it is logged here and does
        # not travel.
        logger.warning(
            "ffmpeg exited %s: %s",
            completed.returncode,
            completed.stderr.decode("utf-8", "replace")[-500:],
        )
        raise TranscodeError(
            "This recording could not be converted. It may be damaged or "
            "in a format Orion cannot read."
        )
    if not os.path.exists(target) or os.path.getsize(target) == 0:
        # Reachable: ffmpeg exits 0 having written a zero-byte file when the
        # input has no audio stream at all -- a screen recording with the
        # microphone off. Uploading that would produce a silent, valid,
        # completely useless MP3 under a name that promises otherwise.
        raise TranscodeError("This recording has no audio to convert.")


def _extension(object_key: str) -> str:
    """The source's extension, kept so ffmpeg can use it as a hint.

    ffmpeg probes the content rather than trusting the name, so this only
    matters for the handful of formats whose probe is ambiguous. Restricted to
    something extension-shaped because it is going into a filesystem path.
    """
    _, ext = os.path.splitext(object_key or "")
    ext = ext.lower()
    return ext if 2 <= len(ext) <= 6 and ext[1:].isalnum() else ""
