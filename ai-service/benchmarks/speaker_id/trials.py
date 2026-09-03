"""Building profiles, enumerating trials, and asking the shipped matcher.

Two rules govern this file.

**The profile is built the way `learn` builds one.** Production folds each new
appearance into the stored vector with `centroid([*[previous] * samples, new])`
— a running mean in which every appearance counts once however long they spoke
for. Averaging enrolment clips any other way (concatenating the audio, or
weighting by duration) would measure a profile the product never creates.

**The decision is `match_speakers`, not a copy of it.** The whole point is to
measure what ships, so the accept threshold, the margin rule and the
minimum-speech rule are exercised by importing the real function with its real
defaults. This module never compares a number to 0.55 in order to decide
anything; it only re-derives *which* refusal fired so the CSV can say, and it
raises if that derivation ever disagrees with the matcher.

**Two profile sets per candidate.** A candidate is run twice:

* *closed set* — every enrolled person, including their own. The correct answer
  is their own profile. This is where false rejections come from.
* *open set* — every enrolled person **except** their own, so the right answer
  is that nobody matches. This is where false accepts come from, and it is the
  measurement that matters most: with N enrolled people it turns each test clip
  into a genuine trial and an impostor trial rather than only the first.

A person with no enrolment clip is already an impostor against every profile, so
only the closed run is emitted for them — the open run would be the same set of
profiles and would double-count.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from benchmarks.speaker_id.matching import Candidate, Profile, Thresholds, centroid, cosine, match_speakers

from .embed import Embedder, Voiceprint, fingerprint
from .manifest import Clip

#: The lengths the duration sweep cuts each long clip down to. 6 is the current
#: `speaker_min_speech_seconds`, so it is the shortest input the matcher will
#: look at; 45 is `MAX_SPAN_SECONDS`, beyond which production stops adding
#: audio, so it is the longest input that can differ from another.
SWEEP_SECONDS = (6, 10, 20, 45)


@dataclass(frozen=True)
class Enrolment:
    """One person's profile, folded from their enrolment clips."""

    person: str
    vector: list[float]
    sources: list[str]
    samples: int
    #: Which recording sessions went into it. Carried rather than read back off
    #: the filenames, so "was this test clip recorded on an enrolment day?" is
    #: answered from the data instead of from a string split that a future
    #: naming change would silently break.
    days: tuple[int, ...] = ()

    def as_profile(self) -> Profile:
        return Profile(
            profile_id=f"spf_{self.person}",
            display_name=self.person,
            embedding=self.vector,
            sample_count=self.samples,
        )


def build_profiles(clips: list[Clip], embedder: Embedder) -> dict[str, Enrolment]:
    """Fold each person's enrolment clips into one profile, as `learn` does."""
    by_person: dict[str, list[Clip]] = {}
    for clip in clips:
        if clip.role == "enrol":
            by_person.setdefault(clip.person, []).append(clip)

    profiles: dict[str, Enrolment] = {}
    for person, theirs in sorted(by_person.items()):
        # Chronological, so a profile built from three sessions is built in the
        # order the product would have built it.
        theirs.sort(key=lambda c: (c.day, c.target_seconds, c.take))

        merged: list[float] = []
        samples = 0
        sources: list[str] = []
        days: list[int] = []
        for clip in theirs:
            print_ = embedder.of(clip.path)
            if print_.speech_seconds < Thresholds().min_seconds:
                # Exactly what `learn` does: a profile built from four seconds
                # of one-word answers is worse than no profile, because it sits
                # in the way of a good one later.
                print(f"  skipped for enrolment (too short): {clip.label} "
                      f"({print_.speech_seconds:.1f}s < {Thresholds().min_seconds}s)")
                continue
            merged = print_.vector if not merged else centroid([*([merged] * samples), print_.vector])
            samples += 1
            sources.append(clip.label)
            days.append(clip.day)

        if samples:
            profiles[person] = Enrolment(person, merged, sources, samples, tuple(days))
    return profiles


@dataclass
class Trial:
    """One candidate put to the matcher against one set of profiles."""

    trial_id: str
    mode: str                      # closed | open
    clip: Clip
    #: None for the clip at its natural length; the sweep point otherwise.
    truncated_to: int | None
    speech_seconds: float
    clip_seconds: float
    candidate_fingerprint: str
    profile_people: list[str]
    #: Cosine against every profile offered, highest first.
    scores: list[tuple[str, float]] = field(default_factory=list)
    matched_person: str | None = None
    best_person: str | None = None
    best_similarity: float | None = None
    runner_up: float | None = None
    reason: str = ""

    @property
    def self_enrolled(self) -> bool:
        """Whether the right answer exists in the profile set at all."""
        return self.clip.person in self.profile_people

    @property
    def expected(self) -> str:
        return f"MATCH:{self.clip.person}" if self.self_enrolled else "NO_MATCH"

    @property
    def decision(self) -> str:
        return f"MATCH:{self.matched_person}" if self.matched_person else "NO_MATCH"

    @property
    def correct(self) -> bool:
        return self.decision == self.expected

    @property
    def margin(self) -> float | None:
        if self.best_similarity is None or self.runner_up is None:
            return None
        return self.best_similarity - self.runner_up

    @property
    def outcome(self) -> str:
        """The four boxes, named the way the brief names them."""
        if self.matched_person is None:
            return "false_refusal" if self.self_enrolled else "true_refusal"
        if self.matched_person == self.clip.person:
            return "true_accept"
        return "false_accept"


def _reason(trial: Trial, limits: Thresholds) -> str:
    """Which refusal fired, re-derived for the report only.

    Never used to decide anything — `match_speakers` decides. This exists so the
    CSV can say *why* a row was refused, and it is checked against the matcher's
    answer immediately below, so a future change to the rules shows up here as a
    loud disagreement rather than a quietly wrong column.
    """
    if trial.speech_seconds < limits.min_seconds:
        return "too_little_speech"
    if not trial.scores:
        return "no_profiles"
    if trial.best_similarity is not None and trial.best_similarity < limits.accept:
        return "below_threshold"
    if trial.margin is not None and trial.margin < limits.margin:
        return "margin_too_small"
    return "matched"


def run_trial(trial: Trial, vector: list[float], profiles: list[Enrolment]) -> Trial:
    """Score the candidate, then let the shipped matcher decide."""
    limits = Thresholds()

    trial.scores = sorted(
        ((p.person, cosine(vector, p.vector)) for p in profiles),
        key=lambda pair: pair[1],
        reverse=True,
    )
    if trial.scores:
        trial.best_person, trial.best_similarity = trial.scores[0]
        trial.runner_up = trial.scores[1][1] if len(trial.scores) > 1 else None

    matches = match_speakers(
        [Candidate(
            speaker_key="spk_1",
            embedding=vector,
            speech_seconds=trial.speech_seconds,
        )],
        [p.as_profile() for p in profiles],
        thresholds=limits,          # the shipped defaults, unmodified
        taken_names=frozenset(),
    )
    trial.matched_person = matches[0].display_name if matches else None
    trial.reason = _reason(trial, limits)

    # The canary. If the re-derived reason says "matched" and the matcher
    # refused (or the reverse), this file has drifted from `app.voiceprints` and
    # every "why" in the report is suspect.
    agreed = (trial.reason == "matched") == (trial.matched_person is not None)
    if not agreed:
        raise AssertionError(
            f"{trial.trial_id}: the harness derived '{trial.reason}' but the matcher "
            f"{'matched' if trial.matched_person else 'refused'}. "
            "benchmarks/speaker_id/trials.py is out of step with app/voiceprints.py."
        )
    return trial


@dataclass(frozen=True)
class Comparison:
    """One candidate against one profile: the row the distributions are made of."""

    trial: Trial
    profile_person: str
    profile_sources: list[str]
    profile_samples: int
    profile_days: tuple[int, ...]
    similarity: float

    @property
    def same_person(self) -> bool:
        return self.profile_person == self.trial.clip.person

    @property
    def same_session(self) -> bool:
        """Whether this clip came from a session the profile was also built in.

        The flattering case: two recordings from one sitting share a room, a mic
        position and a voice that has not slept since, so they say less about
        recognising somebody next week than the number suggests.
        """
        return self.trial.clip.day in self.profile_days


def evaluate(
    clips: list[Clip],
    profiles: dict[str, Enrolment],
    embedder: Embedder,
    *,
    truncate: bool = False,
) -> tuple[list[Trial], list[Comparison]]:
    """Every test clip, at every length asked for, in both profile sets."""
    everyone = [profiles[p] for p in sorted(profiles)]
    trials: list[Trial] = []
    comparisons: list[Comparison] = []

    tests = sorted(
        (c for c in clips if c.role == "test"),
        key=lambda c: (c.person, c.day, c.device, c.environment, c.target_seconds, c.take),
    )
    if not tests:
        return trials, comparisons

    for clip in tests:
        natural = embedder.of(clip.path)
        lengths: list[tuple[int | None, Voiceprint]] = [(None, natural)]

        if truncate:
            for point in SWEEP_SECONDS:
                # A sweep point at or beyond the clip's own length would just be
                # the clip again under a second name.
                if natural.clip_seconds <= point + 0.25:
                    continue
                try:
                    lengths.append((point, embedder.of(clip.path, limit_seconds=point)))
                except Exception as exc:  # noqa: BLE001
                    print(f"  {clip.label} @ {point}s: {exc}")

        for cut, print_ in lengths:
            for mode in ("closed", "open"):
                offered = (
                    everyone if mode == "closed"
                    else [e for e in everyone if e.person != clip.person]
                )
                # A person with no profile of their own is already an impostor
                # in the closed set; the open set would be identical.
                if mode == "open" and clip.person not in profiles:
                    continue
                if not offered:
                    continue

                suffix = "full" if cut is None else f"{cut}s"
                trial = Trial(
                    trial_id=f"{clip.path.stem}#{suffix}#{mode}",
                    mode=mode,
                    clip=clip,
                    truncated_to=cut,
                    speech_seconds=print_.speech_seconds,
                    clip_seconds=print_.clip_seconds,
                    candidate_fingerprint=fingerprint(print_.vector),
                    profile_people=[e.person for e in offered],
                )
                run_trial(trial, print_.vector, offered)
                trials.append(trial)

                # Comparisons come from the closed run only. The open run scores
                # the same candidate against the same profiles minus one, so
                # counting both would enter every different-person pair twice
                # and quietly halve the apparent spread of the distribution.
                if mode == "closed":
                    for person, score in trial.scores:
                        enrolment = profiles[person]
                        comparisons.append(Comparison(
                            trial=trial,
                            profile_person=person,
                            profile_sources=enrolment.sources,
                            profile_samples=enrolment.samples,
                            profile_days=enrolment.days,
                            similarity=score,
                        ))

    return trials, comparisons
