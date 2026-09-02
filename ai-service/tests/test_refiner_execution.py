"""Does the acoustic stage actually run, and if not does it say why?

Every other test in this family asks whether a rule reaches the right answer.
This one asks whether the rules run at all — which sounds like a lesser question
and was, in production, the entire question.

## The meeting this exists for

A build containing meeting-wide region reconciliation was deployed, and a real
recording processed after it reported:

```
AssemblyAI returned 27 segment(s) across 5 speaker(s)
Provider labels ['A', 'B', 'C', 'D', 'E']
Downloading audio from S3 object key
Speaker refinement made no change:
  reason=fewer than two speakers with usable reference audio
  examinedTurns=0 usableReferences=0 providerSpeakers=5 canonicalSpeakers=0
  regions=0
```

`DIARIZATION_TRACE` was on and there was not one `region at=` line, so the
reconciler had not run. But the reason given is a sentence **about the
recording** — twenty-seven segments and five speakers had "no usable reference
audio" — and `canonicalSpeakers=0` describes no meeting that can exist.

Both were artefacts of one thing. `SpeakerRefiner._default_sampler` caught every
exception from the embedder and returned `None`, one span at a time. That is
defensible for a single span and wrong across a meeting: an embedder that cannot
load fails *every* span identically, and the refiner then reports the absence of
evidence it was never in a position to produce.

So the tests here are about the difference between:

    the recording had nothing usable in it
    the acoustic stage never worked

which had been the same log line.
"""

from __future__ import annotations

import logging

import pytest

from app.rediarize import Limits, SpeakerRefiner
from tests.test_rediarize import ALICE, BOB, seg, timeline, voice

CAROL, DAVE, ERIN = voice(3), voice(4), voice(5)

#: The reported utterance timings, and the same shape around them: 27 segments,
#: five provider labels, turns long enough that whole-turn reference audio does
#: not exist. `(start, end, label, voice)`.
PRODUCTION = [
    (0.991, 72.615, "A", ALICE),
    (72.615, 77.111, "B", BOB),
    (77.111, 114.918, "A", ALICE),
    (118.788, 121.624, "C", CAROL),
    (121.624, 137.252, "D", DAVE),
    (141.898, 147.622, "A", ALICE),
    (147.622, 154.578, "E", ERIN),
    (154.578, 171.0, "A", ALICE),
    (171.0, 184.0, "C", CAROL),
    (184.0, 241.0, "A", ALICE),
    (241.0, 249.0, "B", BOB),
    (249.0, 268.0, "A", ALICE),
    (268.0, 300.0, "C", CAROL),
    (300.0, 346.0, "A", ALICE),
    (346.0, 361.0, "B", BOB),
    (361.0, 379.0, "A", ALICE),
    (379.0, 404.0, "C", CAROL),
    (404.0, 412.0, "B", BOB),
    (412.0, 428.141, "A", ALICE),
    (428.141, 541.810, "E", ERIN),
    (541.810, 556.0, "A", ALICE),
    (556.0, 572.180, "C", CAROL),
    (572.180, 617.075, "D", DAVE),
    (617.075, 625.0, "A", ALICE),
    (625.0, 640.0, "E", ERIN),
    (640.0, 663.0, "A", ALICE),
    (663.0, 699.0, "C", CAROL),
]


def production(rows=None):
    """The reported meeting, as segments and a matching sampler."""
    order: dict[str, int] = {}
    segments, spans = [], []
    for start, end, label, speaks in (rows if rows is not None else PRODUCTION):
        if label not in order:
            order[label] = len(order) + 1
        number = order[label]
        segment = seg(start, end, f"Speaker {number}", f"spk_{number}",
                      n=max(4, int((end - start) * 2)))
        segment.speaker_raw = label
        for word in segment.words:
            word.speaker_raw = label
        segments.append(segment)
        spans.append((start, end, speaks))
    return segments, timeline(*spans)


async def refine(segments, sampler, limits=None):
    refiner = SpeakerRefiner(limits=limits, sampler_for=sampler)

    async def loader():
        return b"audio"

    return await refiner.refine(list(segments), loader)


def silent(_audio):
    """An embedder that answers nothing, ever — the deployed failure."""
    def sample(_start, _end):
        return None
    return sample


def broken(_audio):
    """An embedder that raises on every span — a model that will not load."""
    def sample(_start, _end):
        from app.providers.ecapa_embedder import SpeakerEmbeddingUnavailable

        raise SpeakerEmbeddingUnavailable("the speaker embedding model could not be loaded")
    return sample


class TestTheReportedShape:
    """A. Five labels and real audio: the region stage runs."""

    def test_the_fixture_reproduces_what_production_sent(self):
        # Guards the fixture. If any turn here were short enough to be trusted
        # whole, or there were fewer than five labels, this file would be
        # testing a different meeting from the one that failed.
        segments, _ = production()

        assert len(segments) == 27
        assert len({s.speaker_raw for s in segments}) == 5
        assert sum(1 for s in segments if s.end - s.start > 6.0) >= 20

    async def test_region_evidence_is_built(self):
        segments, sampler = production()

        _, report = await refine(segments, sampler)

        assert report.provider_speakers == 5
        assert report.regions > 0
        assert report.references == 5

    async def test_the_reconciler_actually_runs(self):
        # The invariant this release is about, and the one production violated:
        # usable acoustic regions exist, so the region stage gets to look at
        # them. Not that it must change anything.
        segments, sampler = production()

        _, report = await refine(segments, sampler)

        assert report.reconciliation_ran is True
        assert report.skipped_reason is None

    async def test_the_embedder_is_asked_and_answers(self):
        segments, sampler = production()

        _, report = await refine(segments, sampler)

        assert report.embedding_attempts > 0
        assert report.embedding_successes > 0
        assert report.embedding_failures == 0


class TestNoPreconditionStandsInFrontOfTheRegionStage:
    """B. A reference count may not decide whether regions are examined."""

    async def test_two_speakers_with_region_evidence_is_enough_to_run(self):
        # The gate is expressed over the region evidence itself -- one entry per
        # speaker the audio could say anything about -- so there is no separate
        # reference builder able to veto the stage. Pinned, because that is
        # exactly the shape the production failure looked like from outside.
        segments, sampler = production()

        _, report = await refine(segments, sampler)

        assert report.references >= 2
        assert report.reconciliation_ran is True

    async def test_long_turns_alone_still_produce_evidence(self):
        # The old reference rule took whole short turns and nothing else, so a
        # meeting made entirely of long ones yielded nothing. Every turn in this
        # fixture is long. Five speakers and twenty-seven segments must not come
        # out as zero acoustic evidence.
        segments, sampler = production()

        _, report = await refine(segments, sampler)

        assert report.regions >= 5
        assert report.references == 5

    async def test_one_long_turn_does_not_supply_a_speaker_s_whole_reference(self):
        # And the diversified policy is still in force: a turn contributes one
        # region however many windows fit inside it, so several temporal regions
        # take part.
        segments, sampler = production()
        refiner = SpeakerRefiner(sampler_for=sampler)

        regions = refiner._regions(segments, sampler(b"audio"))

        assert len(regions["Speaker 1"]) > 1
        assert all(len(found) >= 1 for found in regions.values())


class TestWhenTheAcousticStageCannotRun:
    """C-H. Preserve the provider's answer, and say which stage failed."""

    async def test_an_embedder_that_never_answers_says_so(self):
        # F, and the deployed failure exactly. This used to report that the
        # *recording* had no usable reference audio in it.
        segments, sampler = production()

        out, report = await refine(segments, broken)

        assert report.skipped_reason == "the embedder returned nothing for any span"
        assert report.embedding_attempts > 0
        assert report.embedding_successes == 0
        assert report.embedding_failures == report.embedding_attempts
        assert report.reconciliation_ran is False
        assert [s.speaker for s in out] == [s.speaker for s in segments]

    async def test_an_embedder_that_declines_every_span_says_so(self):
        # E. Different from the above: the embedder works and refuses, which is
        # what it does for audio it cannot judge.
        segments, _ = production()

        out, report = await refine(segments, silent)

        assert report.skipped_reason == "the embedder returned nothing for any span"
        assert report.embedding_refusals == report.embedding_attempts
        assert report.embedding_failures == 0
        assert [s.speaker for s in out] == [s.speaker for s in segments]

    async def test_a_meeting_the_provider_gave_one_speaker_is_left_alone(self):
        # G. Nothing to compare against, and inventing somebody is out of the
        # question. Named apart from the two above so the log distinguishes a
        # quiet meeting from a broken deployment.
        rows = [(start, end, "A", ALICE) for start, end, _label, _v in PRODUCTION]
        segments, sampler = production(rows)

        out, report = await refine(segments, sampler)

        assert report.skipped_reason == "only one speaker produced usable reference audio"
        assert report.embedding_successes > 0
        assert len({s.speaker for s in out}) == 1

    async def test_no_embedder_at_all_is_a_different_sentence(self):
        # C. Reported before any audio is fetched, so nothing is downloaded for
        # a deployment that cannot use it.
        segments, _ = production()
        refiner = SpeakerRefiner()
        refiner._checked, refiner._embedder = True, None

        async def loader():
            return b"audio"

        out, report = await refiner.refine(list(segments), loader)

        assert report.skipped_reason == "embedder not installed"
        assert report.provider_speakers == 5
        assert [s.speaker for s in out] == [s.speaker for s in segments]

    async def test_no_audio_is_a_different_sentence_again(self):
        # D.
        segments, _ = production()
        refiner = SpeakerRefiner(sampler_for=timeline((0.0, 700.0, ALICE)))

        async def loader():
            return b""

        out, report = await refiner.refine(list(segments), loader)

        assert report.skipped_reason == "no audio available"
        assert [s.speaker for s in out] == [s.speaker for s in segments]

    async def test_a_recording_that_will_not_decode_is_named_as_such(self):
        # The remaining stage. It used to surface as `failed: <ExcType>`, which
        # is true and does not say that the *decode* is what failed.
        from app.providers.ecapa_embedder import SpeakerEmbeddingUnavailable

        segments, _ = production()

        def undecodable(_audio):
            raise SpeakerEmbeddingUnavailable("the recording could not be decoded")

        out, report = await refine(segments, undecodable)

        assert report.skipped_reason is not None
        assert [s.speaker for s in out] == [s.speaker for s in segments]

    @pytest.mark.parametrize("sampler_for", [silent, broken])
    async def test_no_speaker_is_ever_guessed_without_evidence(self, sampler_for):
        # H, and the rule the whole file is in service of: insufficient evidence
        # never becomes an invented assignment.
        segments, _ = production()
        before = [(s.speaker, s.speaker_key, s.speaker_raw) for s in segments]

        out, report = await refine(segments, sampler_for)

        assert [(s.speaker, s.speaker_key, s.speaker_raw) for s in out] == before
        assert report.merged == 0
        assert report.labels_split == 0
        assert report.substantial_reassigned == 0
        assert report.islands_corrected == 0


class TestTheDefaultSamplerPath:
    """The production path exactly: no injected sampler, a model that will not load.

    Every other test here injects a sampler, which is the wrong shape for this
    one bug: the swallowing was inside `_default_sampler`, so an injected
    sampler never went through it. Reproduced against the deployed build, this
    fixture emits the production log line word for word --

        reason=fewer than two speakers with usable reference audio
        usableReferences=0 providerSpeakers=5 canonicalSpeakers=0 regions=0

    -- which is what makes it the anchor test rather than one more variation.

    The fault it stands for is real and is not hypothetical: `installed()` asks
    `find_spec` whether torch and speechbrain are importable, which they are in
    the image, and says nothing about whether the model behind them can be
    fetched and loaded. `load()` answers that, lazily, from inside `embed()` --
    inside the per-span `except`.
    """

    class ModelWillNotLoad:
        """torch and speechbrain import; the model does not load."""

        def load(self):
            from app.providers.ecapa_embedder import SpeakerEmbeddingUnavailable

            raise SpeakerEmbeddingUnavailable(
                "the speaker embedding model could not be loaded: OSError")

        def embed(self, waveform):
            self.load()

    @staticmethod
    def _decoded(monkeypatch, seconds: float = 700.0):
        import numpy as np

        from app.providers import ecapa_embedder

        monkeypatch.setattr(
            ecapa_embedder, "decode_to_pcm",
            lambda audio, **kwargs: np.zeros(
                int(seconds * ecapa_embedder.SAMPLE_RATE), dtype="float32"),
        )

    async def _run(self, monkeypatch, embedder):
        self._decoded(monkeypatch)
        segments, _ = production()
        refiner = SpeakerRefiner(embedder=embedder)

        async def loader():
            return b"audio-bytes"

        out, report = await refiner.refine(list(segments), loader)
        return segments, out, report

    async def test_a_model_that_will_not_load_names_itself(self, monkeypatch):
        segments, out, report = await self._run(monkeypatch, self.ModelWillNotLoad())

        assert report.skipped_reason == "the embedding model could not be loaded"
        assert [s.speaker for s in out] == [s.speaker for s in segments]

    async def test_it_is_asked_once_and_not_once_per_span(self, monkeypatch):
        # It used to be asked inside every `embed`, so the same deployment fault
        # was reported as fifty-one separate spans having nothing in them.
        _, _, report = await self._run(monkeypatch, self.ModelWillNotLoad())

        assert report.embedding_attempts == 0
        assert report.reconciliation_ran is False

    async def test_the_decode_is_known_to_have_worked(self, monkeypatch):
        # The figure that separates this from a recording that would not decode,
        # and the one that was missing when it mattered.
        _, _, report = await self._run(monkeypatch, self.ModelWillNotLoad())

        assert report.audio_seconds == 700
        assert report.canonical_speakers == 5

    async def test_a_working_model_reaches_the_region_stage(self, monkeypatch):
        # The other half: the same path, with an embedder that answers.
        class Works:
            def load(self):
                return None

            def embed(self, waveform):
                return list(ALICE)

        _, _, report = await self._run(monkeypatch, Works())

        assert report.embedding_attempts > 0
        assert report.embedding_successes == report.embedding_attempts
        assert report.regions > 0


class TestTheSummaryLine:
    """§10: one line that distinguishes the two failures from each other."""

    async def test_it_carries_the_figures_that_separate_them(self):
        segments, sampler = production()

        _, report = await refine(segments, sampler)

        line = report.as_log_fields()
        for field in ("providerSpeakers", "regions", "usableReferences",
                      "audioSeconds", "embeddingAttempts", "embeddingSuccesses",
                      "embeddingRefusals", "embeddingFailures",
                      "reconciliationRan"):
            assert f"{field}=" in line

    async def test_a_working_meeting_and_a_broken_embedder_read_differently(self):
        segments, sampler = production()

        _, ran = await refine(segments, sampler)
        _, failed = await refine(segments, broken)

        assert "reconciliationRan=True" in ran.as_log_fields()
        assert "reconciliationRan=False" in failed.as_log_fields()
        assert "embeddingSuccesses=0 " in failed.as_log_fields()

    async def test_the_speaker_count_is_never_reported_as_zero(self):
        # `canonicalSpeakers=0` alongside `providerSpeakers=5` describes no
        # meeting that can exist, and it cost a deployment cycle of reading the
        # failure as an empty recording.
        segments, _ = production()

        _, report = await refine(segments, broken)

        assert report.canonical_speakers == report.provider_speakers == 5

    async def test_the_line_says_nothing_about_what_was_said(self):
        segments, sampler = production()

        _, report = await refine(segments, sampler)

        line = report.as_log_fields()
        assert "\n" not in line
        for segment in segments:
            assert segment.text not in line
            assert segment.speaker_raw not in line.replace("=", " ").split()


class TestTheTraceProvesItRan:
    """I. `DIARIZATION_TRACE=true` produces safe region diagnostics."""

    @staticmethod
    async def emit(caplog, sampler_for):
        segments, _ = production()
        refiner = SpeakerRefiner(sampler_for=sampler_for)
        refiner._trace_enabled = True

        async def loader():
            return b"audio"

        with caplog.at_level(logging.INFO, logger="ai-service.rediarize"):
            await refiner.refine(segments, loader)
        return [record.getMessage() for record in caplog.records]

    async def test_region_lines_appear_when_the_stage_runs(self, caplog):
        _, sampler = production()

        lines = await self.emit(caplog, sampler)

        assert [line for line in lines if " region at=" in line]

    async def test_per_label_lines_say_how_far_each_one_got(self, caplog):
        _, sampler = production()

        lines = [line for line in await self.emit(caplog, sampler) if " label " in line]

        assert len(lines) == 5
        for field in ("ordinal=", "providerSegments=", "candidateRegions=",
                      "sampledWindows=", "embeddingSuccesses=",
                      "independentRegions=", "accepted="):
            assert all(field in line for line in lines)

    async def test_a_broken_embedder_leaves_no_region_lines_but_still_reports(self, caplog):
        # The production symptom, reproduced: zero `region at=` lines. What is
        # different now is that the per-label lines say every label reached zero
        # successful embeddings, so the silence is explained rather than
        # mysterious.
        lines = await self.emit(caplog, broken)

        assert not [line for line in lines if " region at=" in line]
        labels = [line for line in lines if " label " in line]
        assert len(labels) == 5
        assert all("embeddingSuccesses=0" in line for line in labels)
        assert all("accepted=False" in line for line in labels)

    async def test_the_trace_carries_no_transcript_content(self, caplog):
        segments, sampler = production()

        lines = "\n".join(await self.emit(caplog, sampler))

        for segment in segments:
            assert segment.text not in lines
        assert not any(f"raw={label}" in lines for label in "ABCDE")
