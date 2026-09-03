"""The normal meeting pipeline, with no acoustic model anywhere near it.

Stages one and two of removing ECAPA. Stage one took the acoustic refinement
out of the automatic path; stage two deleted it. The embedder itself is still
here, for cross-meeting voice identity ("Rematch speakers") only, which stage
three removes. A meeting now goes:

    AssemblyAI final transcript + provider diarization
      -> CanonicalSpeakers  (speakerRaw -> speakerKey)
      -> naming
      -> summary / actions / RAG

These tests are the ones that would notice it coming back. The interesting
failure is not "torch is missing" — it is somebody reintroducing an import, an
optional refiner argument or a lazy load, and the accuracy question quietly
becoming a deployment question again.

## Why the import-graph tests matter more than they look

`torch` costs seconds to import and hundreds of megabytes resident. It is still
installed, because cross-meeting voice identity has not been removed yet, so a
single module-level import of it anywhere in this graph would put it back into
every process that serves a meeting — and nothing about the transcript would
look wrong.
"""

from __future__ import annotations

import importlib
import inspect
import subprocess
import sys

import pytest

from app.providers.mock_adapter import MockLlmAdapter, MockTranscriptionAdapter
from app.schemas import Segment, TranscriptResponse


def seg(speaker: str, key: str, text: str, start: float, end: float) -> Segment:
    return Segment(start=start, end=end, speaker=speaker, speaker_key=key,
                   text=text, speaker_status="attributed", speaker_raw=None)


class TestTheRuntimeNeverReachesTheRefiner:

    def test_the_pipeline_takes_no_refiner_argument(self):
        # A parameter that is accepted and ignored is worse than none: three
        # call sites passed it positionally, so leaving it would have shifted
        # `diarizer` by one and failed silently.
        from app.pipeline import Pipeline

        assert "refiner" not in inspect.signature(Pipeline.__init__).parameters

    def test_the_pipeline_neither_stores_nor_calls_a_refiner(self):
        # By code, not by mention: both modules explain in comments why the
        # refiner is gone, and a test that banned the word would fail for
        # saying something true.
        from app import pipeline

        source = inspect.getsource(pipeline)
        assert "self._refiner" not in source
        assert "SpeakerRefiner(" not in source
        assert ".refine(" not in source

    def test_main_does_not_construct_one(self):
        from app import main

        assert "SpeakerRefiner(" not in inspect.getsource(main)
        assert "refiner" not in inspect.signature(
            importlib.import_module("app.pipeline").Pipeline.__init__).parameters

    @pytest.mark.parametrize("module", ["app.main", "app.pipeline", "app.naming",
                                        "app.diarization", "app.kafka_worker"])
    def test_importing_the_runtime_pulls_in_no_acoustic_code(self, module):
        # In a clean interpreter, because `sys.modules` is process-wide and a
        # test that ran earlier could have imported any of these itself.
        probe = (
            "import importlib, json, sys\n"
            f"importlib.import_module({module!r})\n"
            "print(json.dumps([m for m in sys.modules if m in "
            "('app.rediarize','app.regions','torch','torchaudio','speechbrain')"
            " or 'ecapa' in m]))\n"
        )
        done = subprocess.run([sys.executable, "-c", probe], capture_output=True,
                              text=True, timeout=180)
        assert done.returncode == 0, done.stderr[-2000:]

        import json
        leaked = json.loads(done.stdout.strip().splitlines()[-1])
        assert leaked == [], f"{module} pulled in {leaked}"


class TestNamingOwnsItsOwnFloor:

    def test_naming_imports_nothing_acoustic(self):
        from app import naming

        source = inspect.getsource(naming)
        for banned in ("ecapa_embedder", "app.rediarize", "app.regions",
                       "app.voiceprints"):
            assert f"import {banned}" not in source
            assert f"from {banned}" not in source

    def test_the_floor_is_a_number_this_module_owns(self):
        from app import naming

        # Unchanged in value and meaning. It was the embedder's refusal
        # threshold; it is now simply the shortest stretch anything can
        # attribute with confidence.
        assert naming.MIN_VERIFIABLE_SECONDS == 0.8

    def test_the_placeholder_test_moved_but_did_not_change(self):
        # `is_unresolved` lives in `app.diarization`, which owns the labels it
        # describes. It was moved out of `app.voiceprints` before that module
        # was deleted, which is why naming never noticed.
        from app.diarization import is_unresolved

        assert is_unresolved("Speaker 2") is True
        assert is_unresolved("spk_3") is True
        assert is_unresolved("Speaker of the House") is False
        assert is_unresolved(None) is False


class TestAMeetingStillComesOutRight:
    """The provider's diarization, straight through."""

    def transcript(self):
        return TranscriptResponse(
            transcript="Speaker 1: Morning Michael.\nSpeaker 2: I am good, Charles.",
            language="en",
            segments=[
                seg("Speaker 1", "spk_1", "Morning Michael.", 0.0, 4.0),
                seg("Speaker 2", "spk_2", "I am good, Charles.", 4.0, 8.0),
            ],
        )

    async def run(self, response, **kwargs):
        from app.pipeline import Pipeline

        class _Provider:
            async def transcribe(self, audio, filename, language=None, *, request=None):
                return response

        pipeline = Pipeline(_Provider(), MockLlmAdapter(), **kwargs)
        return await pipeline.process("mtg_stage1", b"audio", "a.wav")

    async def test_the_provider_segments_are_passed_through_untouched(self):
        response = self.transcript()
        before = [(s.start, s.end, s.text) for s in response.segments]

        result = await self.run(response, name_speakers=False)

        assert [(s.start, s.end, s.text) for s in result.segments] == before

    async def test_speaker_raw_is_untouched_provider_provenance(self):
        response = self.transcript()
        response.segments[0].speaker_raw = "A"
        response.segments[1].speaker_raw = "B"

        result = await self.run(response, name_speakers=False)

        assert [s.speaker_raw for s in result.segments] == ["A", "B"]

    async def test_speaker_key_is_still_a_separate_deterministic_identity(self):
        response = self.transcript()
        response.segments[0].speaker_raw = "A"

        result = await self.run(response, name_speakers=False)

        # Two fields, two different values, neither derived from the other at
        # display time. Collapsing them is the thing this stage must not do.
        assert result.segments[0].speaker_raw == "A"
        assert result.segments[0].speaker_key == "spk_1"
        assert result.segments[0].speaker_key != result.segments[0].speaker_raw

    async def test_timestamps_survive(self):
        result = await self.run(self.transcript(), name_speakers=False)

        assert [s.start for s in result.segments] == [0.0, 4.0]
        assert [s.end for s in result.segments] == [4.0, 8.0]

    async def test_naming_still_runs_and_still_reads_the_dialogue(self):
        # The headline naming case, through the pipeline, with no acoustic
        # stage in front of it.
        class _Llm(MockLlmAdapter):
            async def identify_speaker_names(self, dialogue, labels, language="en"):
                from app.schemas import SpeakerNameClaim

                return [
                    SpeakerNameClaim(speaker="Speaker 2", name="Michael", turn=1,
                                     quote="Morning Michael", basis="addressed"),
                    SpeakerNameClaim(speaker="Speaker 1", name="Charles", turn=2,
                                     quote="I am good, Charles", basis="addressed"),
                ]

        from app.pipeline import Pipeline

        response = self.transcript()

        class _Provider:
            async def transcribe(self, audio, filename, language=None, *, request=None):
                return response

        result = await Pipeline(_Provider(), _Llm()).process("mtg_named", b"a", "a.wav")

        assert [s.speaker for s in result.segments] == ["Charles", "Michael"]
        # And the keys did not move underneath the names.
        assert [s.speaker_key for s in result.segments] == ["spk_1", "spk_2"]


class TestSpeakerProvisional:
    """Written only by the refiner, which no longer runs. Left in the schema."""

    def test_the_field_still_exists_and_defaults_to_false(self):
        # Kept deliberately for now: removing a schema field is a separate
        # change with its own blast radius, and nothing is harmed by a flag
        # that is simply never set.
        assert seg("Speaker 1", "spk_1", "hello", 0.0, 4.0).speaker_provisional is False

    async def test_normal_segments_come_out_of_the_pipeline_unflagged(self):
        from app.pipeline import Pipeline

        response = TranscriptResponse(
            transcript="Speaker 1: hello", language="en",
            segments=[seg("Speaker 1", "spk_1", "hello there everyone", 0.0, 4.0)],
        )

        class _Provider:
            async def transcribe(self, audio, filename, language=None, *, request=None):
                return response

        result = await Pipeline(_Provider(), MockLlmAdapter(),
                                name_speakers=False).process("m", b"a", "a.wav")

        # Nothing fabricates a value now that the only writer is gone.
        assert all(s.speaker_provisional is False for s in result.segments)

    def test_naming_treats_an_unflagged_turn_as_soundly_owned(self):
        from app import naming

        segments = [
            seg("Speaker 1", "spk_1", "Morning Michael.", 0.0, 4.0),
            seg("Speaker 2", "spk_2", "Morning.", 4.0, 8.0),
        ]

        # The other half of `_ownership_is_sound` -- the duration floor -- still
        # applies, so naming has not become unconditional.
        assert naming.open_labels(segments) == ["Speaker 1", "Speaker 2"]
        segments[1].end = 4.2
        assert "Speaker 2" not in naming.open_labels(segments)


class TestWithoutTorchInstalledAtAll:
    """What a stage-two image looks like, asserted before it is built."""

    def test_a_meeting_processes_with_the_acoustic_packages_hidden(self):
        # A clean interpreter with torch and speechbrain blocked at import.
        # This is the property that makes deleting them safe later: it must
        # already be true now.
        probe = """
import sys, asyncio, types
class _Block:
    def find_module(self, name, path=None):
        return self if name.split('.')[0] in ('torch','torchaudio','speechbrain') else None
    def load_module(self, name):
        raise ImportError('blocked: ' + name)
sys.meta_path.insert(0, _Block())

from app.pipeline import Pipeline
from app.providers.mock_adapter import MockLlmAdapter
from app.schemas import Segment, TranscriptResponse

segments = [Segment(start=0.0, end=4.0, speaker='Speaker 1', speaker_key='spk_1',
                    speaker_raw='A', text='Morning Michael.', speaker_status='attributed'),
            Segment(start=4.0, end=8.0, speaker='Speaker 2', speaker_key='spk_2',
                    speaker_raw='B', text='I am good, Charles.', speaker_status='attributed')]
response = TranscriptResponse(transcript='x', language='en', segments=segments)

class _Provider:
    async def transcribe(self, audio, filename, language=None, *, request=None):
        return response

out = asyncio.run(Pipeline(_Provider(), MockLlmAdapter(),
                           name_speakers=False).process('m', b'a', 'a.wav'))
assert [s.speaker_raw for s in out.segments] == ['A', 'B'], 'speakerRaw lost'
assert [s.speaker_key for s in out.segments] == ['spk_1', 'spk_2'], 'speakerKey lost'
assert len(out.segments) == 2
assert 'torch' not in sys.modules and 'speechbrain' not in sys.modules
print('OK')
"""
        done = subprocess.run([sys.executable, "-c", probe], capture_output=True,
                              text=True, timeout=180)
        assert done.returncode == 0, done.stderr[-3000:]
        assert done.stdout.strip().endswith("OK")

    def test_naming_imports_with_them_hidden(self):
        probe = """
import sys
class _Block:
    def find_module(self, name, path=None):
        return self if name.split('.')[0] in ('torch','torchaudio','speechbrain') else None
    def load_module(self, name):
        raise ImportError('blocked: ' + name)
sys.meta_path.insert(0, _Block())

from app import naming
segs = []
assert naming.resolve([], segs) == {}
assert naming.MIN_VERIFIABLE_SECONDS == 0.8
print('OK')
"""
        done = subprocess.run([sys.executable, "-c", probe], capture_output=True,
                              text=True, timeout=180)
        assert done.returncode == 0, done.stderr[-3000:]


class TestCrossMeetingIdentityIsGone:
    """Stage 3A removed the product feature. The model is stage 3B."""

    @pytest.mark.parametrize("module", ["app.speaker_identity", "app.voiceprints"])
    def test_the_identity_modules_are_gone(self, module):
        with pytest.raises(ModuleNotFoundError):
            importlib.import_module(module)

    def test_no_setting_suggests_voices_are_remembered(self):
        from app.config import Settings

        left = [n for n in Settings.model_fields if "speaker" in n.lower()]
        # Naming reads the words of one meeting and carries nothing between
        # recordings, so it stays. Nothing else does.
        assert left == ["speaker_naming_enabled"]

    def test_the_embedder_is_gone(self):
        # Stage 4. It was kept through 3A/3B so that deleting the model, its
        # Docker layers and torch stayed a separate change with its own blast
        # radius. Nothing in the service ever called it after stage 1.
        with pytest.raises(ModuleNotFoundError):
            importlib.import_module("app.providers.ecapa_embedder")

    def test_the_meeting_local_refiner_is_gone(self):
        # Stage two deleted it. Stage one had made it unreachable, which is
        # what made deleting it a removal rather than a change of behaviour.
        for module in ("app.rediarize", "app.regions"):
            with pytest.raises(ModuleNotFoundError):
                importlib.import_module(module)

    def test_no_speaker_identity_route_is_mounted(self):
        from app.routers.ai import router

        mounted = {r.path for r in router.routes}
        for gone in ("/ai/speakers/identify", "/ai/speakers/learn",
                     "/ai/speakers/forget"):
            assert gone not in mounted
        assert not [p for p in mounted if "speaker" in p.lower()]

class TestNoRouteOrSettingRemembersAVoice:
    """Stage 3A: the product no longer claims to remember anybody's voice."""

    def test_no_speaker_identity_route_survives(self):
        from app.routers.ai import router

        mounted = {r.path for r in router.routes}
        for gone in ("/ai/speakers/identify", "/ai/speakers/learn",
                     "/ai/speakers/forget"):
            assert gone not in mounted
        assert not [p for p in mounted if "speaker" in p.lower()]

    def test_no_request_or_response_schema_survives(self):
        import app.schemas as schemas

        gone = {"SpeakerTurnsDto", "SpeakerIdentifyRequest", "SpeakerIdentifyResponse",
                "SpeakerMatchDto", "SpeakerLearnRequest", "SpeakerLearnResponse",
                "SpeakerForgetRequest", "SpeakerForgetResponse"}
        assert gone & set(dir(schemas)) == set()
        # The two that are not voice identity stay: one is a naming claim about
        # the words of one meeting, the other is a speaker-count hint.
        assert hasattr(schemas, "SpeakerNameClaim")
        assert hasattr(schemas, "SpeakerExpectation")

    def test_the_encryption_key_setting_is_gone_with_its_only_consumer(self):
        from app.config import Settings

        assert "speaker_profile_key" not in Settings.model_fields

    def test_nothing_in_the_service_reaches_a_voice_template(self):
        # The resurrection guard. Those tables no longer exist -- Spring
        # migration V68 dropped them and erased their contents -- so a module
        # that named one would be querying a table that is gone.
        import pathlib as _p

        root = _p.Path(__file__).resolve().parent.parent / "app"
        offenders = []
        for path in root.rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            for banned in ("speaker_profiles", "meeting_speaker_voiceprints",
                           "speaker_learning_enabled", "SpeakerIdentityService"):
                if banned in text:
                    offenders.append(f"{path.name}: {banned}")
        assert offenders == [], offenders


class TestNothingCanReintroduceTheModel:
    """The resurrection guard, over the files where it would actually happen.

    Not the source alone. A model comes back through a *manifest* — a line in
    `requirements.txt`, an extra in `pyproject.toml`, a `pip install` in the
    Dockerfile — and none of those are Python that an import test would notice.
    By the time anything imports it, the image is already far larger and the
    cold start already seconds longer.

    Documentation is exempt: `docs/` has to be able to say what was tried, what
    it measured and why it went, and deleting that record to satisfy a string
    search would throw away the evidence for the decision.
    """

    BANNED = ("torch", "torchaudio", "speechbrain", "EcapaEmbedder",
              "/opt/models/ecapa", "check_speaker_model")

    @pytest.mark.parametrize("name", ["requirements.txt", "pyproject.toml", "Dockerfile"])
    def test_no_manifest_installs_an_acoustic_model(self, name):
        import pathlib as _p

        path = _p.Path(__file__).resolve().parent.parent / name
        # Comments are where these files explain why the model went, so only the
        # instructions are checked: a dependency line or a `pip install`.
        body = "\n".join(
            line for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")
        )
        for banned in self.BANNED:
            assert banned not in body, f"{name} reintroduces {banned}"

    def test_no_production_module_names_the_model(self):
        import pathlib as _p

        root = _p.Path(__file__).resolve().parent.parent / "app"
        offenders = []
        for path in root.rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            for banned in ("import torch", "import speechbrain", "EcapaEmbedder",
                           "/opt/models/ecapa", "check_speaker_model"):
                if banned in text:
                    offenders.append(f"{path.name}: {banned}")
        assert offenders == [], offenders

    def test_the_deleted_files_stay_deleted(self):
        import pathlib as _p

        root = _p.Path(__file__).resolve().parent.parent
        for gone in ("app/providers/ecapa_embedder.py",
                     "scripts/check_speaker_model.py",
                     "benchmarks/speaker_id"):
            assert not (root / gone).exists(), gone

    def test_the_image_still_installs_ffmpeg(self):
        # The one thing in that layer that must not go with the model: MP3
        # export shells out to it, and `app/transcode.py` is a live feature.
        import pathlib as _p

        dockerfile = (_p.Path(__file__).resolve().parent.parent
                      / "Dockerfile").read_text(encoding="utf-8")
        assert "ffmpeg" in dockerfile
