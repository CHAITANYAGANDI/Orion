"""Converting a recording to MP3, and refusing to do it twice.

The claim under test is narrow and absolute: a file Reverie calls ``.mp3``
contains MP3. Everything else here defends the two ways that claim gets broken
in practice — a rename dressed up as a conversion, and a conversion that ran
four times because somebody clicked four times.

The encode itself is not run. ffmpeg is in the image and exercised by the
speaker embedder; what is asserted here is the *command*, because
``libmp3lame`` is the one thing in this module whose absence produces a file
with the wrong contents and the right name. Every other failure produces no
file at all, which is loud.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import tempfile

import pytest

from app.config import Settings
from app.transcode import (
    FAILED,
    READY,
    RUNNING,
    Mp3Transcoder,
    TranscodeError,
    ffmpeg_command,
    run_ffmpeg,
)

SOURCE = "meetings/usr_1/mtg_1/recording.webm"
TARGET = "meetings/usr_1/mtg_1/recording.webm.mp3"


def settings() -> Settings:
    return Settings(s3_bucket="reverie", s3_endpoint="http://minio:9000")


# --------------------------------------------------------------------------- #
# The command
# --------------------------------------------------------------------------- #


def test_encodes_with_a_real_mp3_codec():
    # The whole feature in one assertion. Renaming a webm to .mp3 is the bug
    # this exists to make impossible, and libmp3lame is what makes the
    # difference between a conversion and a rename.
    assert "libmp3lame" in ffmpeg_command("in.webm", "out.mp3")


def test_drops_a_video_track_rather_than_encoding_it():
    # A screen recording and a phone video both arrive as containers with a
    # video stream. Encoding it would waste minutes; leaving it in would
    # produce something that is not an MP3.
    assert "-vn" in ffmpeg_command("in.mp4", "out.mp3")


def test_never_prompts():
    # -y and -nostdin. A prompt on a service with no terminal is not a
    # question, it is a hang that ends at the timeout.
    command = ffmpeg_command("in.wav", "out.mp3")
    assert "-y" in command
    assert "-nostdin" in command


def test_reads_the_source_and_writes_the_target():
    command = ffmpeg_command("/tmp/source.m4a", "/tmp/out.mp3")

    assert command[command.index("-i") + 1] == "/tmp/source.m4a"
    assert command[-1] == "/tmp/out.mp3"


# --------------------------------------------------------------------------- #
# What run_ffmpeg does with a bad outcome
# --------------------------------------------------------------------------- #


class _Completed:
    def __init__(self, returncode: int, stderr: bytes = b""):
        self.returncode = returncode
        self.stderr = stderr
        self.stdout = b""


def test_a_failed_encode_says_something_a_person_can_read(monkeypatch):
    monkeypatch.setattr(
        subprocess, "run",
        lambda *a, **k: _Completed(1, b"[matroska @ 0x5] EBML header parsing failed"),
    )

    with pytest.raises(TranscodeError) as caught:
        run_ffmpeg("in.webm", "out.mp3", timeout=10)

    message = str(caught.value)
    # ffmpeg's stderr names the file and the container's internals. It is
    # logged; it does not travel to a browser.
    assert "EBML" not in message
    assert "damaged" in message or "cannot read" in message


def test_a_silent_result_is_a_failure_not_a_file(monkeypatch, tmp_path):
    # Reachable, and the nastiest of the lot: ffmpeg exits 0 having written
    # nothing when the input has no audio stream -- a screen recording with the
    # microphone off. Uploading that produces a valid, silent, useless MP3
    # under a name that promises a meeting.
    target = tmp_path / "out.mp3"
    target.write_bytes(b"")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Completed(0))

    with pytest.raises(TranscodeError) as caught:
        run_ffmpeg("in.mp4", str(target), timeout=10)

    assert "no audio" in str(caught.value)


def test_a_missing_encoder_is_reported_as_unavailable_not_as_corruption(monkeypatch):
    def missing(*a, **k):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(subprocess, "run", missing)

    with pytest.raises(TranscodeError) as caught:
        run_ffmpeg("in.webm", "out.mp3", timeout=10)

    # Telling somebody their recording is damaged when the deployment is
    # missing a binary sends them to delete and re-upload a perfectly good file.
    assert "not available" in str(caught.value)


def test_a_recording_that_takes_too_long_suggests_the_original(monkeypatch):
    def slow(*a, **k):
        raise subprocess.TimeoutExpired(cmd="ffmpeg", timeout=900)

    monkeypatch.setattr(subprocess, "run", slow)

    with pytest.raises(TranscodeError) as caught:
        run_ffmpeg("in.wav", "out.mp3", timeout=900)

    # There is a way out, and it is worth saying: Original always works.
    assert "original format" in str(caught.value)


def test_run_ffmpeg_accepts_a_real_encode_if_ffmpeg_is_installed(tmp_path):
    """The genuine article, when the machine has an encoder.

    Skipped where ffmpeg is absent rather than mocked, because a mocked
    encode proves nothing about MP3. Where it does run, it is the only test in
    the suite that shows bytes going in one format and coming out another.
    """
    if _which("ffmpeg") is None:
        pytest.skip("ffmpeg is not installed here; the image has it.")

    source = tmp_path / "tone.wav"
    subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=1", str(source)],
        check=True,
    )
    target = tmp_path / "tone.mp3"

    run_ffmpeg(str(source), str(target), timeout=60)

    data = target.read_bytes()
    assert len(data) > 0
    # An ID3 tag or an MPEG frame sync. Either proves the encoder ran; neither
    # is producible by renaming a wav.
    assert data[:3] == b"ID3" or data[0] == 0xFF


def _which(name: str) -> str | None:
    import shutil

    return shutil.which(name)


# --------------------------------------------------------------------------- #
# The state machine, which is where the concurrency lives
# --------------------------------------------------------------------------- #


class _Recorder:
    """A conversion that can be held open, so two callers can overlap."""

    def __init__(self):
        self.calls: list[tuple[str, str]] = []
        self.release = None
        self.fail_with: Exception | None = None

    def __call__(self, source: str, target: str) -> None:
        self.calls.append((source, target))
        if self.release is not None:
            self.release.wait(timeout=5)
        if self.fail_with:
            raise self.fail_with


def transcoder(*, exists=False, convert=None) -> tuple[Mp3Transcoder, _Recorder]:
    recorder = convert or _Recorder()
    seen = exists if callable(exists) else (lambda key: exists)
    return Mp3Transcoder(settings(), convert=recorder, exists=seen), recorder


async def test_an_existing_derivative_is_not_converted_again():
    service, recorder = transcoder(exists=True)

    state = await service.ensure(SOURCE, TARGET)

    assert state.status == READY
    # The point of a deterministic key: a second export of a meeting costs a
    # HEAD, not a minute of CPU.
    assert recorder.calls == []


async def test_a_missing_derivative_starts_one_conversion():
    service, recorder = transcoder()

    state = await service.ensure(SOURCE, TARGET)
    await _settle()

    assert state.status == RUNNING
    assert recorder.calls == [(SOURCE, TARGET)]


async def test_two_requests_at_once_do_not_start_two_conversions():
    """The double-click, which is the case this guard exists for."""
    import threading

    recorder = _Recorder()
    recorder.release = threading.Event()
    service, _ = transcoder(convert=recorder)

    first = await service.ensure(SOURCE, TARGET)
    second = await service.ensure(SOURCE, TARGET)

    assert first.status == RUNNING
    assert second.status == RUNNING
    recorder.release.set()
    await _settle()
    assert len(recorder.calls) == 1


async def test_a_failure_is_reported_once_and_then_retryable():
    recorder = _Recorder()
    recorder.fail_with = TranscodeError("This recording has no audio to convert.")
    service, _ = transcoder(convert=recorder)

    await service.ensure(SOURCE, TARGET)
    await _settle()

    # The poll that finds the failure gets the sentence.
    reported = await service.ensure(SOURCE, TARGET)
    assert reported.status == FAILED
    assert reported.message == "This recording has no audio to convert."

    # And the failure is then forgotten, so pressing "Try again" actually
    # tries again. Remembering it would make the retry button a lie; clearing
    # it any earlier would mean the poll that should have shown the error
    # silently started a second doomed conversion instead.
    recorder.fail_with = None
    again = await service.ensure(SOURCE, TARGET)
    await _settle()
    assert again.status == RUNNING
    assert len(recorder.calls) == 2


async def test_an_unexpected_crash_does_not_leak_its_traceback():
    recorder = _Recorder()
    recorder.fail_with = RuntimeError("boto3 exploded at 0x7f in _upload_part")
    service, _ = transcoder(convert=recorder)

    await service.ensure(SOURCE, TARGET)
    await _settle()
    reported = await service.ensure(SOURCE, TARGET)

    assert reported.status == FAILED
    assert "boto3" not in (reported.message or "")
    assert "0x7f" not in (reported.message or "")


async def test_a_crash_still_releases_the_guard():
    # Without the `finally`, one failure would wedge the recording as
    # permanently "running" for the life of the process -- a meeting nobody can
    # ever export again, cured only by a restart.
    recorder = _Recorder()
    recorder.fail_with = RuntimeError("boom")
    service, _ = transcoder(convert=recorder)

    await service.ensure(SOURCE, TARGET)
    await _settle()
    await service.ensure(SOURCE, TARGET)  # drains the remembered failure
    await service.ensure(SOURCE, TARGET)
    await _settle()

    assert len(recorder.calls) == 2


async def test_a_storage_that_will_not_answer_is_a_failure_not_a_conversion():
    def broken(_key: str) -> bool:
        raise RuntimeError("credentials")

    service, recorder = transcoder(exists=broken)

    state = await service.ensure(SOURCE, TARGET)

    assert state.status == FAILED
    # Starting an encode that has nowhere to upload to would burn a minute of
    # CPU to fail at the last step.
    assert recorder.calls == []


class _Missing(Exception):
    """Shaped like botocore's ClientError for a HEAD that found nothing."""

    def __init__(self, status: int):
        super().__init__("head failed")
        self.response = {"ResponseMetadata": {"HTTPStatusCode": status}}


@pytest.mark.parametrize("status", [404, 403])
def test_a_missing_object_reads_as_absent(status):
    # 403 as well as 404: S3 answers a HEAD for an object that is not there
    # with 403 when the token cannot list the bucket, and R2 follows it.
    class _Client:
        def head_object(self, **_kw):
            raise _Missing(status)

    service = Mp3Transcoder(settings())
    service._client = lambda: _Client()  # noqa: SLF001

    assert service._exists_in_storage(TARGET) is False  # noqa: SLF001


def test_a_broken_store_is_raised_rather_than_read_as_absent():
    # The distinction that matters: False is read by the caller as permission
    # to spend a minute of CPU converting, and a store that cannot answer a
    # HEAD will not accept the upload at the end of it either.
    class _Client:
        def head_object(self, **_kw):
            raise _Missing(500)

    service = Mp3Transcoder(settings())
    service._client = lambda: _Client()  # noqa: SLF001

    with pytest.raises(Exception):
        service._exists_in_storage(TARGET)  # noqa: SLF001


async def test_missing_keys_are_refused_rather_than_converted():
    service, recorder = transcoder()

    assert (await service.ensure("", TARGET)).status == FAILED
    assert (await service.ensure(SOURCE, "")).status == FAILED
    assert recorder.calls == []


async def test_a_too_large_recording_is_refused_before_it_is_downloaded():
    """The size guard runs off a HEAD, not off the file on disk."""
    service = Mp3Transcoder(
        Settings(s3_bucket="reverie", transcode_max_bytes=1_000),
        exists=lambda key: False,
    )

    class _Client:
        def head_object(self, **_kw):
            return {"ContentLength": 5_000_000_000}

        def download_file(self, *a, **k):  # pragma: no cover - must not run
            raise AssertionError("the recording was downloaded despite the limit")

    service._client = lambda: _Client()  # noqa: SLF001 - the seam under test

    with pytest.raises(TranscodeError) as caught:
        service._convert_via_ffmpeg(SOURCE, TARGET)  # noqa: SLF001

    assert "too large" in str(caught.value)


async def test_an_unknown_size_is_not_treated_as_too_large():
    """A HEAD that fails must not refuse a recording that would convert fine."""

    class _Client:
        def head_object(self, **_kw):
            raise RuntimeError("no such method on this store")

    assert Mp3Transcoder._source_size(_Client(), "reverie", SOURCE) is None  # noqa: SLF001


def test_the_working_directory_is_cleaned_up_even_when_the_encode_fails(monkeypatch):
    """A service that leaks a copy of every failed recording into /tmp is a
    privacy problem that only surfaces when the disk fills."""
    made: list[str] = []
    real = tempfile.TemporaryDirectory

    class _Watched(real):  # type: ignore[misc]
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            made.append(self.name)

    monkeypatch.setattr(tempfile, "TemporaryDirectory", _Watched)

    class _Client:
        def head_object(self, **_kw):
            return {"ContentLength": 10}

        def download_file(self, *a, **k):
            raise RuntimeError("storage is down")

    service = Mp3Transcoder(settings(), exists=lambda key: False)
    service._client = lambda: _Client()  # noqa: SLF001

    with pytest.raises(TranscodeError):
        service._convert_via_ffmpeg(SOURCE, TARGET)  # noqa: SLF001

    assert made and not os.path.exists(made[0])


async def test_the_upload_declares_the_bytes_as_audio_mpeg(monkeypatch):
    """What the object is stored as, quite apart from what the presign says.

    Both matter. The presigned URL overrides the response type, so a browser is
    told the truth either way -- but anything reading the bucket directly, now
    or in five years, gets the same answer only if this is right.
    """
    uploaded: dict[str, object] = {}

    class _Client:
        def head_object(self, **_kw):
            return {"ContentLength": 10}

        def download_file(self, bucket, key, path):
            with open(path, "wb") as handle:
                handle.write(b"not really audio")

        def upload_file(self, path, bucket, key, ExtraArgs=None):  # noqa: N803
            uploaded.update({"bucket": bucket, "key": key, "extra": ExtraArgs})

    service = Mp3Transcoder(settings(), exists=lambda key: False)
    service._client = lambda: _Client()  # noqa: SLF001
    monkeypatch.setattr("app.transcode.run_ffmpeg", lambda src, dst, timeout: _write(dst))

    service._convert_via_ffmpeg(SOURCE, TARGET)  # noqa: SLF001

    assert uploaded["key"] == TARGET
    assert uploaded["extra"] == {"ContentType": "audio/mpeg"}


def _write(path: str) -> None:
    with open(path, "wb") as handle:
        handle.write(b"ID3fake-mp3")


async def _settle() -> None:
    """Let the background conversion task run to completion."""
    for _ in range(50):
        await asyncio.sleep(0)
        if not any(not task.done() for task in asyncio.all_tasks() - {asyncio.current_task()}):
            break
    await asyncio.sleep(0.05)
