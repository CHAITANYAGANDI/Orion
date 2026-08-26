"""Turning trials into the seven answers, and refusing to overstate them.

Three habits run through this file.

**Every rate is printed with its denominator.** "FAR 0%" out of four impostor
trials is not a measurement, and the only way to stop it being read as one is to
put the 4 next to it. Where a count of zero is reported, the 95% upper bound at
that sample size is printed beside it, because zero failures in a small sample
is not evidence of no failures.

**Nothing is tuned.** The distributions are described and the current settings
are scored. No alternative threshold is proposed, because choosing one from a
dataset this size is how a threshold ends up fitted to six people's microphones.

**ASCII only.** This is read in a terminal, and on Windows a console that is not
in UTF-8 turns every em-dash into a replacement character in the middle of a
number the reader is trying to trust.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass

from app.voiceprints import Thresholds

from .trials import Comparison, Trial


def percentile(values: list[float], q: float) -> float:
    """Linear-interpolated percentile. No numpy, so the report runs anywhere."""
    if not values:
        return float("nan")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * q
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    weight = position - low
    return ordered[low] * (1 - weight) + ordered[high] * weight


@dataclass(frozen=True)
class Spread:
    n: int
    minimum: float
    p25: float
    median: float
    p75: float
    maximum: float

    @classmethod
    def of(cls, values: list[float]) -> "Spread":
        if not values:
            return cls(0, *([float("nan")] * 5))
        return cls(
            n=len(values),
            minimum=min(values),
            p25=percentile(values, 0.25),
            median=percentile(values, 0.50),
            p75=percentile(values, 0.75),
            maximum=max(values),
        )

    def row(self, label: str) -> str:
        if self.n == 0:
            # Not 0.000, which would read as "these voices scored zero".
            return f"| {label} | 0 | - | - | - | - | - |"
        return (
            f"| {label} | {self.n} | {self.minimum:.3f} | {self.p25:.3f} | "
            f"{self.median:.3f} | {self.p75:.3f} | {self.maximum:.3f} |"
        )


def _rate(numerator: int, denominator: int) -> str:
    if denominator == 0:
        return "n/a  (no trials of this kind)"
    return f"{100.0 * numerator / denominator:.1f}%  ({numerator}/{denominator})"


def _zero_is_not_none(numerator: int, denominator: int) -> str:
    """The 95% upper bound when nothing went wrong, which is the honest number.

    Zero failures in n trials does not mean the rate is zero; it means the rate
    is below roughly 3/n with 95% confidence. Only says anything when the count
    really is zero -- attached to a non-zero rate it would read as a bound on
    that rate, which it is not.
    """
    if denominator == 0 or numerator > 0:
        return ""
    return (f" Zero is not the same as none: at n={denominator} the 95% upper bound "
            f"is {300.0 / denominator:.1f}%.")


def render(trials: list[Trial], comparisons: list[Comparison], notes: list[str]) -> str:
    limits = Thresholds()
    out: list[str] = []
    w = out.append

    w("# Speaker identification benchmark")
    w("")
    w(f"Settings under test, unmodified: **accept {limits.accept}**, "
      f"**margin {limits.margin}**, **min speech {limits.min_seconds}s**.")
    w("")
    w("Every decision below came from `app.voiceprints.match_speakers` and every")
    w("embedding from the ECAPA model the product loads. Nothing was tuned.")
    w("")

    if notes:
        w("## What this dataset cannot answer")
        w("")
        for note in notes:
            w(f"- {note}")
        w("")

    # ---------------------------------------------------------------- spreads
    same = [c.similarity for c in comparisons if c.same_person]
    different = [c.similarity for c in comparisons if not c.same_person]

    w("## 1-2. Score distributions")
    w("")
    w("Cosine of a test clip against a profile. Same-person pairs are always")
    w("across recordings: a clip is never compared with a profile built from")
    w("itself, because enrolment and test clips are different files.")
    w("")
    w("| | n | min | p25 | median | p75 | max |")
    w("|---|---|---|---|---|---|---|")
    w(Spread.of(same).row("**same person**"))
    w(Spread.of(different).row("**different people**"))
    w("")

    if same and different:
        worst_same, best_different = min(same), max(different)
        gap = worst_same - best_different
        if gap > 0:
            inside = best_different < limits.accept <= worst_same
            w(f"**The two distributions do not overlap.** The worst same-person pair "
              f"({worst_same:.3f}) still scores above the best different-person pair "
              f"({best_different:.3f}), a gap of {gap:.3f}. Any threshold inside that "
              f"gap separates this dataset perfectly, and {limits.accept} "
              + ("is inside it." if inside else
                 f"**is not** -- it sits {'below' if limits.accept <= best_different else 'above'} "
                 f"the gap, so the separation the embeddings offer is not the separation "
                 f"the setting takes."))
        else:
            w(f"**The two distributions overlap.** The best different-person pair "
              f"({best_different:.3f}) scores at or above the worst same-person pair "
              f"({worst_same:.3f}), so no single threshold separates this dataset. The "
              f"overlap is {-gap:.3f} wide, and the margin rule exists for exactly that "
              f"region.")
        w("")
        w(f"Relative to the {limits.accept} accept threshold: the worst same-person pair "
          f"sits {worst_same - limits.accept:+.3f} from it, the best different-person "
          f"pair {best_different - limits.accept:+.3f}.")
        w("")

    # ------------------------------------------------------------- confusion
    genuine = [t for t in trials if t.self_enrolled]
    impostor = [t for t in trials if not t.self_enrolled]
    counts = Counter(t.outcome for t in trials)

    true_accepts = counts["true_accept"]
    false_accepts = counts["false_accept"]
    true_refusals = counts["true_refusal"]
    false_refusals = counts["false_refusal"]
    wrong_person = sum(
        1 for t in genuine if t.matched_person is not None and t.matched_person != t.clip.person
    )
    # The only trials where a false accept was physically possible: at least one
    # profile belonging to somebody else was on the table. A genuine trial run
    # against a single profile -- their own -- cannot produce one, and counting
    # it in the denominator would dilute the rate that matters most.
    exposed = [t for t in trials if any(p != t.clip.person for p in t.profile_people)]
    impostor_matched = sum(1 for t in impostor if t.matched_person)

    w("## 3-4. At the current settings")
    w("")
    w("| | count |")
    w("|---|---|")
    w(f"| true accepts | {true_accepts} |")
    w(f"| **false accepts** | **{false_accepts}** |")
    w(f"| true refusals | {true_refusals} |")
    w(f"| false refusals | {false_refusals} |")
    w("")
    w("**False accept rate** -- somebody's name put on somebody else's voice, the")
    w("failure that matters:")
    w("")
    w(f"- overall: {_rate(false_accepts, len(exposed))} of the {len(exposed)} trial(s) "
      f"where a profile belonging to someone else was available to pick."
      + _zero_is_not_none(false_accepts, len(exposed)))
    w(f"- impostor trials (the speaker is not enrolled at all): "
      f"{_rate(impostor_matched, len(impostor))}"
      + _zero_is_not_none(impostor_matched, len(impostor)))
    w(f"- closed-set confusions (enrolled, but matched to somebody else): "
      f"{_rate(wrong_person, len(genuine))}")
    w("")
    w(f"**False reject rate** -- the speaker was enrolled and went unrecognised: "
      f"{_rate(false_refusals, len(genuine))}")
    w("")
    w("Denominators: a *genuine* trial is a test clip run against a profile set")
    w("containing its own speaker; an *impostor* trial is the same clip run with")
    w("that speaker's profile removed.")
    w("")

    reasons = Counter(t.reason for t in trials if t.matched_person is None)
    if reasons:
        w("Why the refusals happened:")
        w("")
        for reason, count in reasons.most_common():
            w(f"- `{reason}` x {count}")
        w("")
        margin_only = sum(1 for t in genuine if t.reason == "margin_too_small")
        if margin_only:
            w(f"**{margin_only} genuine trial(s) cleared {limits.accept} and were refused "
              f"by the {limits.margin} margin alone.** Whether that is the margin rule "
              f"working or costing recall depends on whether the runner-up was a "
              f"plausible confusion; `trials.csv` names it.")
            w("")

    # -------------------------------------------------------------- duration
    w("## 5. Effect of speech duration")
    w("")
    by_length: dict[int, list[Trial]] = defaultdict(list)
    for t in genuine:
        bucket = t.truncated_to if t.truncated_to is not None else int(round(t.speech_seconds))
        by_length[bucket].append(t)

    if len(by_length) < 2:
        w("Not measured: every genuine trial had effectively the same amount of")
        w("speech. Re-run with `--truncate`, or record 6s/10s/20s/45s takes.")
    else:
        w("Self-similarity is the candidate against its own profile, so it falls as")
        w("the clip gets shorter if and only if short clips really are worse.")
        w("")
        w("| speech seconds | genuine trials | median self-similarity | matched | refused |")
        w("|---|---|---|---|---|")
        for bucket in sorted(by_length):
            group = by_length[bucket]
            selves = [
                score for t in group for person, score in t.scores if person == t.clip.person
            ]
            matched = sum(1 for t in group if t.matched_person == t.clip.person)
            w(f"| {bucket} | {len(group)} | {percentile(selves, 0.5):.3f} | "
              f"{matched} | {len(group) - matched} |")

        # The same cut, from the other side: does a short clip drift toward
        # everybody? That is the specific danger the min-seconds rule names.
        w("")
        w("| speech seconds | impostor trials | max different-person similarity | false accepts |")
        w("|---|---|---|---|")
        by_length_imp: dict[int, list[Trial]] = defaultdict(list)
        for t in impostor:
            bucket = t.truncated_to if t.truncated_to is not None else int(round(t.speech_seconds))
            by_length_imp[bucket].append(t)
        for bucket in sorted(by_length_imp):
            group = by_length_imp[bucket]
            tops = [t.best_similarity for t in group if t.best_similarity is not None]
            accepted = sum(1 for t in group if t.matched_person)
            w(f"| {bucket} | {len(group)} | {max(tops):.3f} | {accepted} |"
              if tops else f"| {bucket} | {len(group)} | - | {accepted} |")
    w("")

    # ------------------------------------------------------------- condition
    w("## 6. Effect of microphone and room")
    w("")
    by_condition: dict[str, list[float]] = defaultdict(list)
    for c in comparisons:
        if c.same_person:
            by_condition[c.trial.clip.condition].append(c.similarity)

    if len(by_condition) < 2:
        w("Not measured: every test clip used the same microphone and room.")
    else:
        w("Same-person similarity grouped by the condition the *test* clip was")
        w("recorded in. The profile side is whatever the enrolment clips were, so")
        w("this is a cross-condition number wherever the two differ.")
        w("")
        w("| test condition | n | min | p25 | median | p75 | max |")
        w("|---|---|---|---|---|---|---|")
        for condition in sorted(by_condition):
            w(Spread.of(by_condition[condition]).row(condition))
    w("")

    by_session: dict[str, list[float]] = defaultdict(list)
    for c in comparisons:
        if c.same_person:
            by_session["same session as enrolment" if c.same_session
                        else "a different session"].append(c.similarity)
    if len(by_session) > 1:
        w("Two clips from one sitting share a room, a mic position and a voice that")
        w("has not slept since. The second row is the one that resembles the product.")
        w("")
        w("| | n | min | p25 | median | p75 | max |")
        w("|---|---|---|---|---|---|---|")
        for key in sorted(by_session):
            w(Spread.of(by_session[key]).row(key))
        w("")

    # ----------------------------------------------------------- hardest pairs
    w("## The two pairs that decide everything")
    w("")
    if same:
        worst = min((c for c in comparisons if c.same_person), key=lambda c: c.similarity)
        w(f"**Hardest same-person pair -- {worst.similarity:.3f}**")
        w("")
        w(f"- candidate `{worst.trial.clip.label}`"
          + (f", cut to {worst.trial.truncated_to}s" if worst.trial.truncated_to else "")
          + f" ({worst.trial.speech_seconds:.1f}s of speech, {worst.trial.clip.condition})")
        w(f"- profile `{worst.profile_person}` from {', '.join(worst.profile_sources)}")
        w(f"- {'above' if worst.similarity >= limits.accept else '**below**'} the "
          f"{limits.accept} threshold"
          + ("" if worst.similarity >= limits.accept
             else " -- this is a name the product would not have restored"))
        w("")
    if different:
        closest = max((c for c in comparisons if not c.same_person), key=lambda c: c.similarity)
        w(f"**Hardest different-person pair -- {closest.similarity:.3f}**")
        w("")
        w(f"- candidate `{closest.trial.clip.label}` ({closest.trial.clip.person}, "
          f"{closest.trial.speech_seconds:.1f}s, {closest.trial.clip.condition})")
        w(f"- profile `{closest.profile_person}` from {', '.join(closest.profile_sources)}")
        w(f"- {'**above**' if closest.similarity >= limits.accept else 'below'} the "
          f"{limits.accept} threshold"
          + (" -- only the margin rule and one-profile-per-speaker stand between this "
             "pair and a wrong name" if closest.similarity >= limits.accept
             else ", refused on similarity alone"))
        w("")

    # ------------------------------------------------------- are they defensible
    w(f"## 7. Are {limits.accept} / {limits.margin} / {limits.min_seconds}s defensible?")
    w("")
    w("Evidence, not a recommendation. No tuning was done and none should be until")
    w("the dataset is large enough -- see the README.")
    w("")
    if same and different:
        below = sum(1 for s in same if s < limits.accept)
        above = sum(1 for s in different if s >= limits.accept)
        tight = sum(1 for t in trials if t.margin is not None and 0 <= t.margin < limits.margin)
        w(f"- **accept {limits.accept}**: {below}/{len(same)} same-person pairs fall below "
          f"it (each one a name the product would not restore), and {above}/{len(different)} "
          f"different-person pairs reach or exceed it (each one a wrong name the later "
          f"rules have to stop).")
        w(f"- **margin {limits.margin}**: {tight} trial(s) had a winner-minus-runner-up "
          f"gap under it. With few enrolled people the margin is rarely the binding "
          f"rule; it binds as the profile count grows, so this number is a floor.")
        w(f"- **min speech {limits.min_seconds}s**: "
          + (f"{sum(1 for t in trials if t.reason == 'too_little_speech')} trial(s) were "
             f"refused for it." if any(t.reason == "too_little_speech" for t in trials)
             else "no trial was short enough to test it. Record 6s takes, or use "
                  "`--truncate`."))
    else:
        w("- Not enough data on both sides to say anything.")
    w("")

    return "\n".join(out)
