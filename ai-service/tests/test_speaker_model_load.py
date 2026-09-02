"""Bringing the speaker embedding model up, and saying why when it will not.

Everything here is about `EcapaEmbedder.load()`, which for two deployments was
the quietest line in the service. `installed()` asked `find_spec` whether torch
and speechbrain import — they did — and the weights behind them were never
anybody's question until a meeting needed one. Then the failure arrived wearing
the recording's clothes:

```
reason=the embedding model could not be loaded
providerSpeakers=7 usableReferences=0 regions=0 embeddingAttempts=0
```

The cause was in the Dockerfile, not here. `EncoderClassifier.from_hparams`
fills its `savedir` with **symlinks into the HuggingFace cache of whoever ran
it** — root, at image build time — and the service runs as `ai`, which cannot
read `/root` (mode 0700 on the base image). All five files came back
`PermissionError: [Errno 13]`.

Reproduced in a container, that is:

```
classifier.ckpt   symlink=True readable=PermissionError(errno=13)
    -> /root/.cache/huggingface/hub/models--speechbrain--spkrec-.../classifier.ckpt
```

So these tests are about the part this module owns: whether the failure is
*legible* when it happens, and whether it stays safe to print. The model itself
is mocked — a real load needs a gigabyte of weights and belongs in
`scripts/check_speaker_model.py`, which the image runs at build time as the user
that will run the service.
"""

from __future__ import annotations

import logging

import pytest

from app.providers.ecapa_embedder import (
    EcapaEmbedder,
    SpeakerEmbeddingUnavailable,
    _directory_state,
    _sanitise,
    _stage_of,
    _versions,
)


class _Encoder:
    """Stands in for SpeechBrain's `EncoderClassifier`."""

    calls = 0

    @classmethod
    def from_hparams(cls, **kwargs):
        cls.calls += 1
        cls.last = kwargs
        return cls()


def _speechbrain(monkeypatch, factory):
    """Put a fake `speechbrain.inference.speaker` on the import path."""
    import sys
    import types

    module = types.ModuleType("speechbrain.inference.speaker")
    module.EncoderClassifier = factory
    parent = types.ModuleType("speechbrain.inference")
    parent.speaker = module
    root = types.ModuleType("speechbrain")
    root.inference = parent
    for name, mod in (("speechbrain", root), ("speechbrain.inference", parent),
                      ("speechbrain.inference.speaker", module)):
        monkeypatch.setitem(sys.modules, name, mod)
    monkeypatch.setattr(EcapaEmbedder, "installed", staticmethod(lambda: True))


class TestASuccessfulLoad:

    def test_the_model_comes_up(self, monkeypatch):
        _Encoder.calls = 0
        _speechbrain(monkeypatch, _Encoder)
        embedder = EcapaEmbedder()

        embedder.load()

        assert embedder._encoder is not None
        assert _Encoder.calls == 1

    def test_it_is_asked_for_on_the_cpu(self, monkeypatch):
        # Render has no GPU. Left to itself SpeechBrain picks a device from what
        # torch reports, and a CUDA-only restore on a CPU box is one of the
        # failure classes this had to be cleared of.
        _speechbrain(monkeypatch, _Encoder)

        EcapaEmbedder().load()

        assert _Encoder.last["run_opts"] == {"device": "cpu"}

    def test_it_is_asked_for_from_the_baked_directory(self, monkeypatch):
        _speechbrain(monkeypatch, _Encoder)
        embedder = EcapaEmbedder(model_dir="/opt/models/ecapa",
                                 source="speechbrain/spkrec-ecapa-voxceleb")

        embedder.load()

        assert _Encoder.last["savedir"] == "/opt/models/ecapa"
        assert _Encoder.last["source"] == "speechbrain/spkrec-ecapa-voxceleb"

    def test_loading_twice_costs_nothing(self, monkeypatch):
        # Called at the top of every `embed`, so a second construction per span
        # would be a model load per window.
        _Encoder.calls = 0
        _speechbrain(monkeypatch, _Encoder)
        embedder = EcapaEmbedder()

        embedder.load()
        embedder.load()
        embedder.load()

        assert _Encoder.calls == 1


class TestWhenItWillNotLoad:

    @staticmethod
    def _raising(exc):
        class Broken:
            @staticmethod
            def from_hparams(**kwargs):
                raise exc
        return Broken

    def test_the_refusal_is_the_documented_one(self, monkeypatch):
        _speechbrain(monkeypatch, self._raising(PermissionError(13, "Permission denied")))

        with pytest.raises(SpeakerEmbeddingUnavailable) as caught:
            EcapaEmbedder().load()

        assert "could not be loaded" in str(caught.value)

    def test_the_caller_is_left_able_to_carry_on(self, monkeypatch):
        # The whole contract: a missing model is a feature being off, never a
        # meeting failing. `SpeakerRefiner` catches this and returns the
        # provider's segmentation untouched.
        _speechbrain(monkeypatch, self._raising(RuntimeError("nope")))
        embedder = EcapaEmbedder()

        with pytest.raises(SpeakerEmbeddingUnavailable):
            embedder.load()

        assert embedder._encoder is None

    def test_the_production_failure_is_reported_with_its_stage(
            self, monkeypatch, caplog, tmp_path):
        # The exact exception the container reproduction produces, against a
        # directory in the shape it produces it from: files present, one of them
        # a link that cannot be followed.
        (tmp_path / "hyperparams.yaml").write_bytes(b"x")
        try:
            (tmp_path / "embedding_model.ckpt").symlink_to(tmp_path / "gone" / "w.ckpt")
        except (OSError, NotImplementedError):
            pytest.skip("symlinks are not available to this process")
        exc = PermissionError(13, "Permission denied",
                              str(tmp_path / "hyperparams.yaml"))
        _speechbrain(monkeypatch, self._raising(exc))

        with caplog.at_level(logging.ERROR, logger="ai-service.voiceprint"):
            with pytest.raises(SpeakerEmbeddingUnavailable):
                EcapaEmbedder(model_dir=str(tmp_path)).load()

        line = caplog.records[0].getMessage()
        assert "exceptionType=PermissionError" in line
        assert "stage=permissions" in line
        assert f"modelDir={tmp_path}" in line
        # The three that separate "not in the image" from "cannot be read".
        assert "dirEntries=2" in line
        assert "symlinks=1" in line
        assert "unreadable=1" in line
        assert "torch=" in line and "speechbrain=" in line and "python=" in line

    @pytest.mark.parametrize("exc, stage", [
        (PermissionError(13, "denied"), "permissions"),
        (FileNotFoundError(2, "missing"), "cache"),
        (ImportError("no torch"), "import"),
        (type("HTTPError", (Exception,), {})(), "download"),
        (type("ConnectionError", (Exception,), {})(), "download"),
        (type("UnpicklingError", (Exception,), {})(), "weights"),
        (type("CUDAOutOfMemoryError", (Exception,), {})(), "device"),
        (ValueError("something else"), "instantiate"),
    ])
    def test_each_failure_class_is_named(self, exc, stage):
        assert _stage_of(exc) == stage


class TestTheDiagnosticIsSafeToPrint:
    """It is logged at ERROR on a deployment holding other people's meetings."""

    def test_a_signed_url_keeps_its_host_and_loses_its_signature(self):
        message = ("403 Client Error for url: https://huggingface.co/speechbrain/"
                   "spkrec/resolve/main/model.ckpt?X-Amz-Signature="
                   "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead")

        out = _sanitise(message)

        assert "https://huggingface.co/[path]" in out
        assert "X-Amz-Signature" not in out
        assert "deadbeef" not in out

    @pytest.mark.parametrize("secret", [
        "hf_ABCDEFGHIJKLMNOPQRSTUVWX",
        "sk-ABCDEFGHIJKLMNOPQRSTUVWX",
        "ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
        "Bearer hf_ABCDEFGHIJKLMNOPQRSTUVWX",
    ])
    def test_credential_shaped_text_is_redacted(self, secret):
        out = _sanitise(f"auth failed using {secret} against the hub")

        assert secret.split()[-1] not in out
        assert "[redacted]" in out

    def test_a_long_opaque_run_is_redacted_even_unlabelled(self):
        out = _sanitise("checksum mismatch " + "a1b2c3d4" * 8)

        assert "a1b2c3d4a1b2c3d4" not in out

    def test_it_is_one_line_and_bounded(self):
        out = _sanitise("a\nb\nc " + "x" * 1000)

        assert "\n" not in out
        assert len(out) <= 240

    def test_the_model_path_survives_because_it_is_not_a_secret(self):
        out = _sanitise("Permission denied: '/opt/models/ecapa/hyperparams.yaml'")

        assert "/opt/models/ecapa/hyperparams.yaml" in out


class TestTheDirectoryReport:
    """The figures that tell "not in the image" from "cannot be read"."""

    def test_a_missing_directory_says_so(self):
        state = _directory_state("/nonexistent/models/ecapa")

        assert "dirExists=False" in state

    def test_a_populated_directory_is_counted(self, tmp_path):
        for name in ("hyperparams.yaml", "embedding_model.ckpt"):
            (tmp_path / name).write_bytes(b"x")

        state = _directory_state(str(tmp_path))

        assert "dirEntries=2" in state
        assert "readable=2" in state
        assert "unreadable=0" in state

    def test_a_dangling_symlink_is_counted_as_unreadable(self, tmp_path):
        # The production shape, as far as a filesystem can express it here: an
        # entry that is present and cannot be followed.
        link = tmp_path / "embedding_model.ckpt"
        try:
            link.symlink_to(tmp_path / "nowhere" / "embedding_model.ckpt")
        except (OSError, NotImplementedError):
            pytest.skip("symlinks are not available to this process")

        state = _directory_state(str(tmp_path))

        assert "symlinks=1" in state
        assert "unreadable=1" in state

    def test_it_reports_no_file_names(self, tmp_path):
        (tmp_path / "hyperparams.yaml").write_bytes(b"x")

        state = _directory_state(str(tmp_path))

        assert "hyperparams" not in state

    def test_versions_name_every_package_that_matters(self):
        out = _versions()

        for name in ("torch", "torchaudio", "speechbrain", "huggingface_hub",
                     "safetensors", "numpy", "python"):
            assert f"{name}=" in out


class TestTheSmokeCommand:
    """`scripts/check_speaker_model.py`, which the image runs at build time."""

    @staticmethod
    def _script():
        from pathlib import Path

        return Path(__file__).resolve().parent.parent / "scripts" / "check_speaker_model.py"

    def test_it_exists_and_is_importable(self):
        assert self._script().is_file()

    def test_it_reports_a_skip_rather_than_a_failure_without_the_model(self):
        # Speaker refinement is optional by design, so an install without torch
        # is not a broken one -- and the exit code has to say that, because the
        # Dockerfile fails the build on a non-zero.
        import subprocess
        import sys

        done = subprocess.run([sys.executable, str(self._script())],
                              capture_output=True, text=True, timeout=300)

        assert done.returncode == 0, done.stdout + done.stderr
        assert "MODEL LOAD:" in done.stdout

    def test_it_prints_nothing_that_needs_redacting(self):
        import subprocess
        import sys

        done = subprocess.run([sys.executable, str(self._script())],
                              capture_output=True, text=True, timeout=300)

        for marker in ("hf_", "sk-", "Bearer ", "X-Amz-Signature"):
            assert marker not in done.stdout
