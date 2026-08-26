"""The command.

    python -m benchmarks.speaker_id.run --audio /audio --out /out

Fails rather than improvises. No audio, no model, an unparseable filename, one
person: each of those stops the run and says what to do about it, because the
one thing a benchmark must never do is produce a plausible number from a dataset
that cannot support it.
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

from .manifest import (
    MINIMUM_PEOPLE,
    Clip,
    ManifestError,
    coverage,
    expected,
    load,
    plan,
)
from .report import render


def _writer(path: Path, columns: list[str]):
    handle = path.open("w", newline="", encoding="utf-8")
    writer = csv.DictWriter(handle, fieldnames=columns)
    writer.writeheader()
    return handle, writer


def _comparison_rows(comparisons) -> list[dict]:
    rows = []
    for c in comparisons:
        t = c.trial
        rows.append({
            "trial_id": t.trial_id,
            "candidate_file": t.clip.label,
            "candidate_person": t.clip.person,
            "candidate_device": t.clip.device,
            "candidate_environment": t.clip.environment,
            "candidate_day": t.clip.day,
            "truncated_to": t.truncated_to if t.truncated_to is not None else "",
            "target_seconds": t.clip.target_seconds,
            "usable_speech_seconds": f"{t.speech_seconds:.2f}",
            "clip_seconds": f"{t.clip_seconds:.2f}",
            # Not the vector. A one-way fingerprint, so two rows that are
            # secretly the same file are visible without disclosing anything.
            "candidate_embedding": t.candidate_fingerprint,
            "profile_person": c.profile_person,
            "profile_files": " + ".join(c.profile_sources),
            "profile_samples": c.profile_samples,
            "expected_identity": "same" if c.same_person else "different",
            "cosine_similarity": f"{c.similarity:.4f}",
            "best_profile": t.best_person or "",
            "best_similarity": "" if t.best_similarity is None else f"{t.best_similarity:.4f}",
            "runner_up_similarity": "" if t.runner_up is None else f"{t.runner_up:.4f}",
            "margin": "" if t.margin is None else f"{t.margin:.4f}",
            "decision": t.decision,
            "decision_reason": t.reason,
            "expected_decision": t.expected,
            "correct": "yes" if t.correct else "no",
        })
    return rows


def _trial_rows(trials) -> list[dict]:
    rows = []
    for t in trials:
        rows.append({
            "trial_id": t.trial_id,
            "mode": t.mode,
            "candidate_file": t.clip.label,
            "candidate_person": t.clip.person,
            "condition": t.clip.condition,
            "day": t.clip.day,
            "truncated_to": t.truncated_to if t.truncated_to is not None else "",
            "usable_speech_seconds": f"{t.speech_seconds:.2f}",
            "candidate_embedding": t.candidate_fingerprint,
            "profiles_offered": " ".join(t.profile_people),
            "own_profile_present": "yes" if t.self_enrolled else "no",
            "best_profile": t.best_person or "",
            "best_similarity": "" if t.best_similarity is None else f"{t.best_similarity:.4f}",
            "runner_up_similarity": "" if t.runner_up is None else f"{t.runner_up:.4f}",
            "margin": "" if t.margin is None else f"{t.margin:.4f}",
            "decision": t.decision,
            "decision_reason": t.reason,
            "expected_decision": t.expected,
            "outcome": t.outcome,
            "correct": "yes" if t.correct else "no",
        })
    return rows


def _plan(people: int) -> str:
    """The recording list, generated from the canonical dataset.

    Printed rather than kept in prose so that the list somebody records and the
    counts the report quotes come from one definition. They disagreed once.
    """
    want = expected(people)
    lines = [
        f"Record {want.files} files: {people} people x "
        f"{want.files // people} recordings each.",
        "",
    ]
    current = ""
    for name in plan(people):
        person = name.split("_", 1)[0]
        if person != current:
            lines.append(f"  {person}")
            current = person
        role = name.split("_")[1]
        lines.append(f"    {'[profile]' if role == 'enrol' else '         '} {name}")

    lines += [
        "",
        "What that measures:",
        f"  {want.enrolments} profiles, {want.test_clips} test clips",
        f"  {want.genuine_trials} genuine trials      (own profile present)",
        f"  {want.impostor_trials} impostor trials     (own profile removed)",
        f"  {want.same_person_comparisons} same-person comparisons",
        f"  {want.different_person_comparisons} different-person comparisons "
        f"({want.test_clips} candidates x {people - 1} wrong profiles)",
        "",
        f"With zero false accepts across {want.impostor_trials} impostor trials, the",
        f"95% upper bound on the false-accept rate is {want.far_upper_bound:.1f}%.",
        "That is the number to weigh before deciding this is enough.",
        "",
        "Every take must be different words. Enrol on one day, test on another.",
        "See benchmarks/speaker_id/README.md before recording anybody.",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="benchmarks.speaker_id.run",
        description="Measure the shipped ECAPA speaker matcher against real voices.",
    )
    parser.add_argument("--audio", type=Path,
                        help="directory of recordings, named by the rule in README.md")
    parser.add_argument("--out", type=Path,
                        help="directory for comparisons.csv, trials.csv and summary.md")
    parser.add_argument("--truncate", action="store_true",
                        help="also evaluate 6s/10s/20s/45s prefixes of every test clip, "
                             "which measures the duration effect without extra recording")
    parser.add_argument("--check", action="store_true",
                        help="validate the filenames and report coverage, then stop. "
                             "Loads no model and reads no audio.")
    parser.add_argument("--plan", nargs="?", type=int, const=MINIMUM_PEOPLE, default=None,
                        metavar="PEOPLE",
                        help=f"print the exact list of recordings to make (default "
                             f"{MINIMUM_PEOPLE} people) and what it will measure, then "
                             f"stop. Reads nothing.")
    args = parser.parse_args(argv)

    if args.plan is not None:
        print(_plan(args.plan))
        return 0

    if args.audio is None or args.out is None:
        parser.error("--audio and --out are required unless --plan is given")

    # ------------------------------------------------------------- the dataset
    try:
        clips: list[Clip] = load(args.audio)
    except ManifestError as exc:
        print(f"\n{exc}\n", file=sys.stderr)
        return 2

    have = coverage(clips)
    print(f"{have.clips} clip(s): {len(have.people)} people, "
          f"{len(have.enrolled)} enrolled, {len(have.tested)} tested")
    print(f"  devices     {', '.join(have.devices)}")
    print(f"  rooms       {', '.join(have.environments)}")
    print(f"  sessions    {', '.join('d' + str(d) for d in have.days)}")
    print(f"  durations   {', '.join(str(d) + 's' for d in have.durations)}")

    gaps = have.gaps()
    for gap in gaps:
        print(f"  ! {gap}")

    if args.check:
        print("\nFilenames are valid. Nothing was decoded and no model was loaded.")
        return 0

    if len(have.enrolled) == 0:
        print("\nNo enrolment recordings, so there are no profiles to match against.\n"
              "Every person needs at least one `_enrol_` clip.", file=sys.stderr)
        return 2
    if len(have.tested) == 0:
        print("\nNo test recordings, so there is nothing to identify.", file=sys.stderr)
        return 2

    # --------------------------------------------------------------- the model
    from .embed import Embedder

    ready, why = Embedder.available()
    if not ready:
        print(f"\n{why}\n", file=sys.stderr)
        return 3

    print("\nLoading ECAPA (a few seconds the first time)...")
    embedder = Embedder()

    from .trials import build_profiles, evaluate

    print("Building profiles from the enrolment clips...")
    profiles = build_profiles(clips, embedder)
    for person, enrolment in sorted(profiles.items()):
        print(f"  {person}: {enrolment.samples} appearance(s) — {', '.join(enrolment.sources)}")
    if not profiles:
        print("\nEvery enrolment clip was too short to build a profile from.",
              file=sys.stderr)
        return 2

    print("Scoring test clips...")
    trials, comparisons = evaluate(clips, profiles, embedder, truncate=args.truncate)
    if not trials:
        print("\nNo trials were produced.", file=sys.stderr)
        return 2

    # -------------------------------------------------------------- the output
    args.out.mkdir(parents=True, exist_ok=True)

    comparison_rows = _comparison_rows(comparisons)
    handle, writer = _writer(args.out / "comparisons.csv", list(comparison_rows[0].keys()))
    writer.writerows(comparison_rows)
    handle.close()

    trial_rows = _trial_rows(trials)
    handle, writer = _writer(args.out / "trials.csv", list(trial_rows[0].keys()))
    writer.writerows(trial_rows)
    handle.close()

    summary = render(trials, comparisons, gaps)
    (args.out / "summary.md").write_text(summary + "\n", encoding="utf-8")

    print(f"\nWrote {len(comparison_rows)} comparisons and {len(trial_rows)} trials "
          f"to {args.out}\n")
    print(summary)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
