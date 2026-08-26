"""The dataset, as read off the filenames.

There is no metadata file and that is deliberate. A sidecar CSV listing who is
in which recording is one editing mistake away from labelling p03's voice as
p04's, and a benchmark whose ground truth is wrong does not fail — it reports a
false-accept rate and looks fine. Putting the label in the filename means the
person who recorded it types it once, at the moment they know the answer, and
every later reader sees the same string.

Everything is validated and nothing is inferred. An unrecognised device, a
missing field, a duration that is not a number: refused by name, with the rule
printed, rather than silently sorted into a bucket that then quietly skews a
distribution.

    p01_enrol_laptop_quiet_d1_45s_01.wav
    └┬┘ └─┬─┘ └─┬──┘ └─┬─┘ └┬┘ └┬┘ └┬┘
     │    │     │      │    │   │   └── take, unique within everything left of it
     │    │     │      │    │   └────── target speech seconds
     │    │     │      │    └────────── recording session ("day")
     │    │     │      └─────────────── background
     │    │     └────────────────────── microphone
     │    └──────────────────────────── what it is used for
     └───────────────────────────────── the speaker, pseudonymous

Pseudonymous on purpose: the CSV this harness writes is a table of measurements
about people's voices, and it should be shareable with somebody debugging a
threshold without also handing them a list of names.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

#: Extensions ffmpeg reads and a browser or phone actually produces. Kept as an
#: allow-list so a stray `.txt` or a `.DS_Store` is reported rather than decoded.
AUDIO_SUFFIXES = (".wav", ".flac", ".m4a", ".mp3", ".webm", ".ogg", ".opus")

#: Closed vocabularies. A typo like `phome` must be an error, not a new device
#: with one recording in it — the per-condition tables are only meaningful if
#: the same condition always spells itself the same way.
DEVICES = ("laptop", "phone", "headset", "earbuds", "external")
ENVIRONMENTS = ("quiet", "noisy")
ROLES = ("enrol", "test")

_NAME = re.compile(
    r"^(?P<person>p\d{2,3})"
    r"_(?P<role>[a-z]+)"
    r"_(?P<device>[a-z]+)"
    r"_(?P<environment>[a-z]+)"
    r"_d(?P<day>\d+)"
    r"_(?P<seconds>\d+)s"
    r"_(?P<take>\d+)$"
)

RULE = (
    "<person>_<role>_<device>_<environment>_d<day>_<seconds>s_<take>.<ext>\n"
    "  person       p01, p02, ... (pseudonymous, two or three digits)\n"
    f"  role         {' | '.join(ROLES)}\n"
    f"  device       {' | '.join(DEVICES)}\n"
    f"  environment  {' | '.join(ENVIRONMENTS)}\n"
    "  day          d1, d2, ... (a recording session; different days matter)\n"
    "  seconds      the target length you aimed for: 6s, 10s, 20s, 45s\n"
    "  take         01, 02, ... unique within the person+role+device+env+day+seconds\n"
    f"  ext          {' | '.join(s.lstrip('.') for s in AUDIO_SUFFIXES)}\n"
    "\nexample: p01_enrol_laptop_quiet_d1_45s_01.wav"
)


class ManifestError(ValueError):
    """A filename that cannot be trusted to say what it contains."""


@dataclass(frozen=True)
class Clip:
    """One recording, and everything the benchmark knows about it up front."""

    path: Path
    person: str
    role: str
    device: str
    environment: str
    day: int
    #: What the recording was *aimed* at. The measured length comes from the
    #: audio itself and is often a second or two off; both are reported, and
    #: every calculation uses the measured one.
    target_seconds: int
    take: int

    @property
    def condition(self) -> str:
        return f"{self.device}/{self.environment}"

    @property
    def label(self) -> str:
        """Short, stable, and safe to print in a shared report."""
        return self.path.name


def parse(path: Path) -> Clip:
    match = _NAME.match(path.stem)
    if match is None:
        raise ManifestError(f"{path.name}: does not match the naming rule.\n\n{RULE}")
    fields = match.groupdict()

    for field, allowed in (("role", ROLES), ("device", DEVICES), ("environment", ENVIRONMENTS)):
        if fields[field] not in allowed:
            raise ManifestError(
                f"{path.name}: {field} '{fields[field]}' is not one of "
                f"{', '.join(allowed)}.\n\n{RULE}"
            )
    if path.suffix.lower() not in AUDIO_SUFFIXES:
        raise ManifestError(
            f"{path.name}: '{path.suffix}' is not an audio extension this reads.\n\n{RULE}"
        )

    return Clip(
        path=path,
        person=fields["person"],
        role=fields["role"],
        device=fields["device"],
        environment=fields["environment"],
        day=int(fields["day"]),
        target_seconds=int(fields["seconds"]),
        take=int(fields["take"]),
    )


def load(directory: Path) -> list[Clip]:
    """Every clip in a directory, validated, or an error naming what is wrong.

    Refuses the whole set rather than skipping bad entries. A benchmark that
    quietly drops the three files it could not parse reports a number for a
    dataset nobody has seen.
    """
    if not directory.is_dir():
        raise ManifestError(
            f"No such directory: {directory}\n\n"
            "Nothing has been recorded yet. See benchmarks/speaker_id/README.md "
            "for what to record and how to name it."
        )

    files = sorted(p for p in directory.iterdir() if p.is_file() and not p.name.startswith("."))
    if not files:
        raise ManifestError(
            f"{directory} is empty.\n\n"
            "See benchmarks/speaker_id/README.md for what to record and how to name it."
        )

    clips = [parse(p) for p in files]

    seen: dict[str, Path] = {}
    for clip in clips:
        if clip.path.stem in seen:  # pragma: no cover - the filesystem prevents it
            raise ManifestError(f"Two files named {clip.path.stem}")
        seen[clip.path.stem] = clip.path
    return clips


@dataclass(frozen=True)
class Coverage:
    """What the dataset does and does not currently support measuring."""

    people: list[str]
    enrolled: list[str]
    tested: list[str]
    devices: list[str]
    environments: list[str]
    days: list[int]
    durations: list[int]
    clips: int

    def gaps(self) -> list[str]:
        """Everything the report would otherwise quietly say nothing about.

        Printed with the results rather than blocking them: a partial dataset is
        worth measuring, as long as the reader is told which of the seven
        questions it cannot answer.
        """
        missing: list[str] = []
        if len(self.people) < 2:
            missing.append(
                "Only one person, so there is no different-person distribution at all "
                "and no false-accept rate can be computed. Record a second person."
            )
        without_enrolment = sorted(set(self.tested) - set(self.enrolled))
        if without_enrolment:
            missing.append(
                "No enrolment recording for: " + ", ".join(without_enrolment)
                + ". Their clips can only ever be impostor trials."
            )
        untested = sorted(set(self.enrolled) - set(self.tested))
        if untested:
            missing.append(
                "No test recording for: " + ", ".join(untested)
                + ". They contribute a profile to be matched against, but no genuine trial."
            )
        if len(self.devices) < 2:
            missing.append(
                "Every recording used the same microphone, so the device effect "
                "(question 6) is unmeasured. Add laptop -> phone or laptop -> headset."
            )
        if "noisy" not in self.environments:
            missing.append(
                "Nothing was recorded in a noisy room, so the condition effect "
                "(question 6) is only measured across microphones."
            )
        if len(self.days) < 2:
            missing.append(
                "Everything was recorded in one session, so same-person variation "
                "across days is unmeasured — and that is the variation that matters, "
                "because two clips from one sitting share a room, a mic position and "
                "a voice that has not slept since."
            )
        if len(self.durations) < 2:
            missing.append(
                "One duration only, so the effect of speech length (question 5) is "
                "unmeasured. Either record 6s/10s/20s/45s takes or run with "
                "--truncate to cut prefixes out of the long ones."
            )
        return missing


def coverage(clips: list[Clip]) -> Coverage:
    return Coverage(
        people=sorted({c.person for c in clips}),
        enrolled=sorted({c.person for c in clips if c.role == "enrol"}),
        tested=sorted({c.person for c in clips if c.role == "test"}),
        devices=sorted({c.device for c in clips}),
        environments=sorted({c.environment for c in clips}),
        days=sorted({c.day for c in clips}),
        durations=sorted({c.target_seconds for c in clips}),
        clips=len(clips),
    )
