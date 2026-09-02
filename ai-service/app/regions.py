"""Who is actually in the meeting, decided in region space rather than label space.

## The bug this exists for

Four turns from the start of a real recording, as Reverie rendered them:

```
[00:00]  Speaker 1
[00:14]  Speaker 2
[00:21]  Speaker 1
[00:27]  Speaker 2
```

One person said all four. The provider had put them under two cluster ids and
Reverie had faithfully reproduced the alternation, because everything upstream
of this module reasons in **provider-label space**: a label was an identity, and
the only question ever asked was whether two labels should be folded together.

That question is not enough, and the evidence now runs in both directions at
once. The same recording shows:

* **over-diarization** — one voice under labels `A` and `B`, alternating for
  eleven minutes;
* **under-diarization** — one label holding a four-second turn from somebody
  else, proved by that label's own regions disagreeing with each other.

So a provider label is demoted here to what it always was: **a prior**. Good
evidence, produced by a model that hears the same audio, and wrong often enough
that it cannot be the last word. What is treated as evidence instead is a
*region* — one stretch of speech, embedded once, standing on its own.

```
meeting -> regions -> region embeddings -> clusters -> per-segment identity
```

## The four steps, and why they are in this order

1. **Withhold** the regions that disagree with their own label. A label holding
   two voices has a centroid sitting between them, describing neither, and
   every later decision is a margin between two similarities — so the midpoint
   has to go before anything is compared to anything.
2. **Merge** labels that the surviving regions say are one voice. After the
   withholding, so the comparison is between two clean references.
3. **Reassign** the withheld regions, to whichever canonical voice they clearly
   match. After the merge, so they are matched against the strongest references
   the meeting can produce. A region that matches nobody goes back where the
   provider put it — *this step never creates a speaker*, which is what keeps a
   fragment from inventing one.
4. **Number** by first *stable* appearance, so an early half-second fragment
   cannot take `Speaker 2` and push every later ordinal along behind it.

## The error-cost policy, which decides every threshold below

A refused merge leaves one person under two names. A reader sees it, and one
rename fixes it. A wrong merge puts two people under one name, destroys the
distinction, and leaves nothing in the transcript to notice it by — it silently
corrupts talk time, action-item ownership, the summary, retrieval and the export
together.

The two are not comparable, so uncertainty resolves one way: **keep separate.**
Every rule here is written as a way of declining.

## What is never consulted

Not a word of transcript. Not how many labels there are, not how much any of
them said, not the meeting title or the account owner. A region is a start, an
end and a vector; the only thing that decides identity here is the sound.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Iterable, Sequence

from app.voiceprints import centroid, cosine


@dataclass(frozen=True)
class Region:
    """One stretch of speech, embedded once, standing on its own as evidence.

    A region is a *turn*, not a window. A ninety-second turn is better evidence
    than a four-second one and is not fifteen independent observations of it, so
    however many windows were embedded inside it they are collapsed to a single
    vector before it votes. `samples` keeps them anyway, because a speaker heard
    only once has no spread *between* regions and would otherwise have no
    measurable consistency at all.
    """

    #: Index of the segment this came from, so a decision can be applied back.
    index: int
    start: float
    end: float
    #: Seconds of audio actually embedded, which is less than `end - start`
    #: for a long turn sampled from its interior.
    seconds: float
    vector: list[float]
    #: The windows behind `vector`, before the collapse to one vote.
    samples: list[list[float]] = field(default_factory=list)


@dataclass
class Cluster:
    """A candidate voice: the regions currently believed to be one person."""

    key: str
    regions: list[Region] = field(default_factory=list)
    #: Regions this label carried that disagree with the rest of it. Held out of
    #: the reference entirely and matched against the whole meeting later.
    withheld: list[Region] = field(default_factory=list)
    #: True where the withheld regions form a second coherent voice rather than
    #: one odd moment: the provider reused a label for two people.
    heterogeneous: bool = False

    @property
    def vector(self) -> list[float]:
        return robust_centroid([region.vector for region in self.regions])

    @property
    def samples(self) -> list[list[float]]:
        return [vec for region in self.regions for vec in region.samples]

    @property
    def seconds(self) -> float:
        return sum(region.seconds for region in self.regions)

    @property
    def consistency(self) -> float | None:
        """How alike this voice's own regions are, or None with too little.

        Between regions where there are two or more, because agreement across
        separate turns is the stronger claim. A speaker heard once falls back to
        the windows inside that one turn — weaker evidence, honestly labelled as
        the only evidence there is, and better than refusing to measure, which
        would quietly make them unmergeable.
        """
        return consistency([r.vector for r in self.regions]) or consistency(self.samples)

    @property
    def first_at(self) -> float:
        return min((region.start for region in self.regions), default=float("inf"))


@dataclass
class Outcome:
    """What the reconciliation decided, and enough counting to log it.

    Counts and scalars only. No names, no text, no vectors — this is what gets
    logged on a deployment holding other people's meetings, so what it cannot
    carry it cannot leak.
    """

    #: Prior label -> the canonical key it ended up under.
    mapping: dict[str, str] = field(default_factory=dict)
    #: Segment index -> canonical key, for the regions that moved on their own.
    moved: dict[int, str] = field(default_factory=dict)
    clusters: dict[str, Cluster] = field(default_factory=dict)
    #: Canonical keys in the order they should be numbered.
    order: list[str] = field(default_factory=list)

    merged: int = 0
    #: Pairs that landed in the maybe-band and were left as two speakers.
    ambiguous: int = 0
    withheld: int = 0
    reassigned: int = 0
    heterogeneous: int = 0
    #: Labels holding a second voice that nobody in the meeting claimed, and how
    #: many of those were actually given an identity of their own. The second is
    #: zero unless `split_labels_enabled`; the first is the evidence for turning
    #: it on, gathered without the deployment being the experiment.
    would_split: int = 0
    split: int = 0


#: `(kind, **fields)` — how a decision is reported without naming anybody.
Trace = Callable[..., None]


# --------------------------------------------------------------------------- #
# Vector arithmetic
# --------------------------------------------------------------------------- #


def consistency(vectors: Sequence[Sequence[float]]) -> float | None:
    """How alike one voice's own evidence is, or None if there is only one of it.

    This is the number that makes merging safe without a magic threshold. Two
    labels scoring 0.99 against each other means nothing on its own: it is
    "obviously the same person" if either label's own regions only manage 0.95
    among themselves, and "two people this model cannot separate" if they manage
    0.999. The same figure, opposite conclusions, and the difference is a
    property of the recording rather than of any constant.
    """
    if len(vectors) < 2:
        return None
    pairs = [
        cosine(a, b)
        for i, a in enumerate(vectors)
        for b in vectors[i + 1:]
    ]
    return sum(pairs) / len(pairs)


def robust_centroid(vectors: Sequence[Sequence[float]]) -> list[float]:
    """The average of the vectors, after discarding the least typical one.

    A reference is only as good as the audio behind it, and one region can be
    ruined by a cough, a door, or the speaker the provider missed. Averaging
    everything lets that one region pull the reference toward a voice its owner
    does not have; the effect is small, and small is enough, because every later
    decision is a margin between two similarities.

    Dropping the *single* least central vector is deliberately the weakest
    version of this — a median or a medoid would also discard the natural
    variation that makes a reference describe a person rather than a moment. It
    is a defence against one bad region, and it is not the defence against a
    label holding two voices: that is what `divide` and the withholding are for,
    because with a third of the evidence wrong there is no "least typical" one
    to drop.
    """
    if len(vectors) < 3:
        return centroid(list(vectors))
    scores = [
        sum(cosine(vec, other) for j, other in enumerate(vectors) if j != i)
        for i, vec in enumerate(vectors)
    ]
    worst = scores.index(min(scores))
    return centroid([v for i, v in enumerate(vectors) if i != worst])


def cross_similarity(first: Sequence[Region], second: Sequence[Region], *,
                     worst: bool = False) -> float:
    """How alike two sets of regions are: the mean, or the weakest pair."""
    pairs = [cosine(a.vector, b.vector) for a in first for b in second]
    if not pairs:
        return 0.0
    return min(pairs) if worst else sum(pairs) / len(pairs)


def agreement(first: Sequence[Region], second: Sequence[Region],
              bar: float) -> float:
    """The fraction of region pairs that clear `bar`.

    A fraction rather than the minimum, and the difference matters at region
    scale. Two labels of one person with six regions each make thirty-six
    comparisons, and demanding that every one of them clear the bar means a
    single unlucky region — a cough, an overlap, a moment of laughter — refuses
    the merge. Requiring most of them keeps the claim strong and stops one
    region speaking for the whole meeting.

    Safe only because a label whose regions genuinely split into two voices has
    already had the minority withheld, so what is being compared here is two
    references that each describe one person.
    """
    pairs = [cosine(a.vector, b.vector) for a in first for b in second]
    if not pairs:
        return 0.0
    return sum(1 for score in pairs if score >= bar) / len(pairs)


def divide(regions: Sequence[Region]) -> tuple[list[Region], list[Region]] | None:
    """Split regions into the two most separated groups, or None.

    Seeded from the least similar pair rather than at random, so the answer does
    not depend on region order, and every other region joins whichever seed it
    is closer to. Deliberately the crudest clustering that can answer the
    question — whether the two groups are *really* two people is decided by the
    caller against the groups' own spread, and a cleverer partition would not
    change that judgement, only make it harder to read.
    """
    if len(regions) < 2:
        return None
    worst, seeds = 2.0, None
    for i, a in enumerate(regions):
        for j, b in enumerate(regions[i + 1:], start=i + 1):
            score = cosine(a.vector, b.vector)
            if score < worst:
                worst, seeds = score, (i, j)
    if seeds is None:
        return None
    left_seed, right_seed = regions[seeds[0]].vector, regions[seeds[1]].vector
    first: list[Region] = []
    second: list[Region] = []
    for region in regions:
        target = (first if cosine(region.vector, left_seed) >= cosine(region.vector, right_seed)
                  else second)
        target.append(region)
    if not first or not second:
        return None
    return first, second


def _seconds(regions: Iterable[Region]) -> float:
    return sum(region.seconds for region in regions)


def separated(regions: Sequence[Region], limits) -> tuple[list[Region], list[Region]] | None:
    """The two voices inside one label, majority first, or None for one voice.

    The single definition of "this label disagrees with itself", used both to
    prune a reference and to refuse a merge involving it.

    Judged against the label's **own spread**, like every other threshold here.
    A voice recorded across a changing meeting varies — somebody moves, a
    headset is adjusted, a laugh is not a sentence — and varying is not
    separating. Two groups count as two people only when they are further apart
    than either group is from itself, so the bar rises for a label whose audio
    is uniform and falls for one that was never uniform to begin with.

    Majority is by **region count**, ties broken by audio — one turn, one vote,
    the same rule that decides everything else here. Counting seconds instead
    reads well and is wrong in the case that matters: a twenty-second turn that
    really does hold two people contributes far more sampled audio than the two
    clean short turns beside it, so it wins the vote and the label keeps the
    voice it should have shed. Counting turns, that turn is outvoted two to one.
    """
    if len(regions) < limits.withhold_min_regions:
        return None
    groups = divide(regions)
    if groups is None:
        return None
    first, second = groups
    within = min(consistency([r.vector for r in first]) or 1.0,
                 consistency([r.vector for r in second]) or 1.0)
    if cross_similarity(first, second) >= within - limits.split_margin:
        return None
    weight = (len(first), _seconds(first)), (len(second), _seconds(second))
    return (first, second) if weight[0] >= weight[1] else (second, first)


# --------------------------------------------------------------------------- #
# The reconciliation
# --------------------------------------------------------------------------- #


def reconcile(priors: dict[str, list[Region]], limits, *,
              trace: Trace | None = None) -> Outcome:
    """Canonical voices from provider labels and the regions under them.

    `priors` maps each provider-derived label to its regions, in the order they
    were spoken. `limits` is anything carrying the thresholds — the refiner's
    `Limits`, in production.
    """
    say: Trace = trace or (lambda *a, **k: None)
    clusters = {key: Cluster(key=key, regions=list(regions))
                for key, regions in priors.items() if regions}
    outcome = Outcome(clusters=clusters)
    if not clusters:
        return outcome

    _withhold(clusters, limits, outcome, say)
    groups = _merge(clusters, limits, outcome, say)
    _reassign(clusters, groups, limits, outcome, say)
    _split(clusters, groups, limits, outcome, say)
    _number(clusters, groups, limits, outcome)
    return outcome


def _withhold(clusters: dict[str, Cluster], limits, outcome: Outcome,
              say: Trace) -> None:
    """Hold back the regions of a label that disagree with the rest of it.

    §4 of the brief, and the reason it comes first: *do not average
    heterogeneous regions into a meaningless midpoint*. A label carrying a
    four-second turn from somebody else has a centroid pulled toward a voice its
    owner does not have, and everything downstream compares margins against that
    centroid.

    Two ways a label can disagree with itself, needing the same treatment:

    * **one odd region** — the provider filed one turn under the wrong label.
      The minority is withheld and the majority keeps the label.
    * **two coherent populations** — the provider reused one label for two
      people all meeting. Also withheld, and additionally flagged, because a
      label like that must never be merged with anything: its reference is an
      average of two people, and an average of two people can resemble a third
      convincingly.

    Judged against the label's own spread, like everything else here. A voice
    recorded across changing conditions varies — somebody moves, a headset is
    adjusted — and varying is not separating.
    """
    for cluster in clusters.values():
        split = separated(cluster.regions, limits)
        if split is None:
            continue
        keep, drop = split
        cluster.regions, cluster.withheld = keep, drop
        # Two voices, or one voice and one stray moment. The distinction is how
        # much audio the minority holds: below the reference floor it is not
        # enough to be anybody, and calling the label heterogeneous on it would
        # block merges the label deserves.
        cluster.heterogeneous = _seconds(drop) >= limits.reference_floor_seconds
        outcome.withheld += len(drop)
        outcome.heterogeneous += int(cluster.heterogeneous)
        say("withhold", regions=len(keep) + len(drop), withheld=len(drop),
            across=round(cross_similarity(keep, drop), 3),
            seconds=round(_seconds(drop), 1), heterogeneous=cluster.heterogeneous)


def _merge(clusters: dict[str, Cluster], limits, outcome: Outcome,
           say: Trace) -> dict[str, list[str]]:
    """Fold labels that the regions say are one voice. Returns groups by root.

    <h2>Why a doubtful pair no longer stops the meeting</h2>

    This used to abandon merging *everywhere* the moment one pair landed in the
    maybe-band, on the reasoning that an ambiguous pair means the references are
    not clean enough to conclude anything from. That reasoning was about label
    references, which were one averaged vector each and could be poisoned
    without any sign of it. Regions changed that: a label that disagrees with
    itself is now detected and pruned before this runs, so an ambiguous pair is
    a statement about **those two voices**, not about the recording.

    It also had a cost that the real evidence made plain. One doubtful pair
    anywhere in an eleven-minute meeting was enough to leave the opening
    speaker alternating between two names for the whole transcript. So doubt is
    now resolved where it occurs: that pair stays two speakers, and every other
    pair is judged on its own evidence.
    """
    names = list(clusters)
    group = {name: name for name in names}

    def root(name: str) -> str:
        while group[name] != name:
            group[name] = group[group[name]]
            name = group[name]
        return name

    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if root(a) == root(b):
                continue
            score = cosine(clusters[a].vector, clusters[b].vector)
            if score < limits.merge_similarity - limits.merge_margin:
                continue                              # comfortably two people
            if score < limits.merge_similarity:
                # Possibly the same person, which is not a reason to merge
                # anybody. Two labels on one person is a rename away.
                outcome.ambiguous += 1
                say("merge", decision="ambiguous", score=round(score, 3))
                continue
            if not one_voice(clusters[a], clusters[b], score, clusters, names,
                             limits, say):
                continue
            say("merge", decision="same", score=round(score, 3),
                regions=len(clusters[a].regions) + len(clusters[b].regions))
            ra, rb = root(a), root(b)
            if ra != rb:
                group[rb] = ra

    groups: dict[str, list[str]] = {}
    for name in names:
        groups.setdefault(root(name), []).append(name)
    outcome.merged = len(names) - len(groups)

    # The regions of a merged voice are one pool from here on. Rebuilt rather
    # than averaged from the two centroids: a label with six regions and one
    # with two describe the same person unequally well, and averaging their
    # averages would weight the thin one as heavily as the thick one.
    for head, members in groups.items():
        if len(members) == 1:
            continue
        clusters[head].regions = [r for name in members for r in clusters[name].regions]
        clusters[head].regions.sort(key=lambda region: region.start)
        clusters[head].withheld = [r for name in members for r in clusters[name].withheld]
        clusters[head].heterogeneous = any(clusters[name].heterogeneous for name in members)
    return groups


def one_voice(a: Cluster, b: Cluster, score: float, clusters: dict[str, Cluster],
              names: Sequence[str], limits, say: Trace) -> bool:
    """Whether two labels are one person. Five ways of saying no.

    A high cosine between two centroids is not evidence by itself, and every
    check here exists because that one number has been wrong in a real meeting.
    """
    if a.heterogeneous or b.heterogeneous:
        # One of these labels holds two voices. Its reference is an average of
        # two people, and an average of two people can resemble a third
        # convincingly — merging on it is how two real humans end up under one
        # name.
        say("merge", decision="refused", why="heterogeneous")
        return False

    if len(a.regions) * len(b.regions) < limits.merge_min_comparisons:
        # Repeated independent evidence, or none. A merge founded on a single
        # region-to-region comparison is one cosine from one model over one
        # stretch of audio, which is exactly the claim this module refuses to
        # act on. Two labels that each spoke once stay two; if either is really
        # a duplicate of a third that *did* speak twice, the merge reaches them
        # through it.
        say("merge", decision="refused", why="one comparison")
        return False

    own_a, own_b = a.consistency, b.consistency
    if own_a is None or own_b is None:
        say("merge", decision="refused", why="no measurable spread")
        return False
    if score < min(own_a, own_b):
        # They agree with each other less well than one of them agrees with
        # itself, which one voice recorded twice does not do.
        say("merge", decision="refused", why="below own spread")
        return False

    if agreement(a.regions, b.regions, limits.merge_similarity) < limits.merge_agreement:
        # Consistently, across regions — not merely on average. A label whose
        # audio is bimodal can have a centroid that sits between its two voices
        # and matches another centroid convincingly while few of its actual
        # regions do.
        say("merge", decision="refused", why="regions disagree")
        return False

    pooled = consistency([r.vector for r in [*a.regions, *b.regions]])
    if pooled is not None and pooled < min(own_a, own_b) - limits.merge_margin:
        # Within-cluster consistency must survive the merge. Two references can
        # be close while the union of their regions is visibly looser than
        # either was, which is what two similar people look like pooled.
        say("merge", decision="refused", why="pooled spread loosens")
        return False

    for other in names:
        if other in (a.key, b.key):
            continue
        near = max(cosine(a.vector, clusters[other].vector),
                   cosine(b.vector, clusters[other].vector))
        if near >= limits.merge_similarity:
            # Not a rival: a third label of the same person, which is what a
            # provider that split one voice five ways produces. Counting it as
            # competition would make every duplicate protect every other
            # duplicate from being recognised.
            continue
        if score - near < limits.merge_margin:
            # Some other established voice is nearly as close, so these
            # references are not telling people apart at all.
            say("merge", decision="refused", why="rival voice")
            return False
    return True


def _reassign(clusters: dict[str, Cluster], groups: dict[str, list[str]],
              limits, outcome: Outcome, say: Trace) -> None:
    """Give each withheld region to the canonical voice it actually matches.

    §9 of the brief: one provider label held a four-second turn belonging to the
    main speaker, and the diversified sampler proved it — that label's regions
    fell into two populations, one of which was somebody else. Detecting it was
    never the hard part; acting on it safely was.

    The mechanism this replaced tried to act by **splitting the label into two
    speakers**, and it was withdrawn after a deployment in which the case it was
    built for was still wrong while other regions had regressed. The difference
    here is that nothing is created. A withheld region is offered to the voices
    that already exist, and if none of them clearly claims it, it goes back
    exactly where the provider put it. There is no path in this function that
    mints a canonical identity, which is what §6 requires and what makes the
    failure mode a missed correction rather than an invented person.

    Three things have to be true before a region moves:

    * it is long enough to be judged on its own — well above the embedder's own
      floor, because a fragment identified from a second of audio is the shape
      of every regression this module has caused;
    * it is one voice all the way through, so that moving the whole of it does
      not move half of somebody else with it;
    * one voice wins by a clear margin over the runner-up;
    * and the winner is a voice the region genuinely resembles, not merely the
      nearest thing in the room.
    """
    candidates = {head: clusters[head] for head in groups}
    for name, cluster in clusters.items():
        for region in cluster.withheld:
            home = _root_of(name, groups)
            if region.seconds < limits.reassign_min_seconds:
                say("reassign", decision="too short", seconds=round(region.seconds, 2))
                continue
            internal = consistency(region.samples)
            if internal is not None and internal < limits.merge_similarity:
                # This turn's own windows disagree with each other, so it may
                # hold two people — which is precisely what the boundary search
                # downstream exists to divide. Handing the whole turn to one
                # speaker would settle by fiat a question the next stage is
                # about to answer properly, and would put half a turn under
                # somebody who did not say it.
                say("reassign", decision="turn is not one voice",
                    internal=round(internal, 3))
                continue
            ranked = sorted(
                ((cosine(region.vector, target.vector), key)
                 for key, target in candidates.items()),
                reverse=True,
            )
            if len(ranked) < 2 or ranked[0][0] - ranked[1][0] < limits.assign_margin:
                say("reassign", decision="ambiguous")
                continue
            score, winner = ranked[0]
            if winner == home:
                continue
            floor = candidates[winner].consistency
            if floor is not None and score < floor - limits.assign_margin:
                # Nearest is not the same as belonging. Without this a region
                # from a fifth person who never spoke again would be handed to
                # whoever happened to be closest.
                say("reassign", decision="no true match", score=round(score, 3))
                continue
            outcome.moved[region.index] = winner
            outcome.reassigned += 1
            candidates[winner].regions.append(region)
            say("reassign", decision="moved", score=round(score, 3),
                runnerUp=round(ranked[1][0], 3), seconds=round(region.seconds, 2))

    for cluster in candidates.values():
        cluster.regions.sort(key=lambda region: region.start)


#: Marks a second voice separated out of one provider label, until `_number`
#: gives every speaker a real ordinal. A control character, so it cannot collide
#: with anything a provider or a user could produce.
_HALF = chr(0) + "b"


def _split(clusters: dict[str, Cluster], groups: dict[str, list[str]], limits,
           outcome: Outcome, say: Trace) -> None:
    """Give a label's unplaced second voice an identity of its own. **Off.**

    What is left after `_reassign` is the hardest case in the module: a label
    holding two people, only one of whom is anywhere else in the meeting. The
    other has no reference to be matched against, so the only way to represent
    them is to create a speaker — and creating a speaker on acoustic evidence
    alone is the mechanism that was built once, deployed, and withdrawn when the
    case it was written for came back still wrong while other regions had
    regressed.

    So it stays behind a switch that is off, and what runs by default is the
    counting: `would_split` is how often the situation arose, which is the
    evidence needed to decide whether to turn it on. The capability is kept
    working, and tested, so that turning it on remains a switch rather than a
    rewrite.
    """
    for head in list(groups):
        cluster = clusters[head]
        unplaced = [r for r in cluster.withheld if r.index not in outcome.moved]
        if not cluster.heterogeneous or not unplaced:
            continue
        outcome.would_split += 1
        say("split", decision="second voice", regions=len(unplaced),
            seconds=round(_seconds(unplaced), 1), applied=limits.split_labels_enabled)
        if not limits.split_labels_enabled:
            continue
        key = f"{head}{_HALF}"
        clusters[key] = Cluster(key=key, regions=sorted(unplaced, key=lambda r: r.start))
        groups[key] = [key]
        for region in unplaced:
            outcome.moved[region.index] = key
        outcome.split += 1
        outcome.reassigned += len(unplaced)


def _root_of(name: str, groups: dict[str, list[str]]) -> str:
    for head, members in groups.items():
        if name in members:
            return head
    return name


def _number(clusters: dict[str, Cluster], groups: dict[str, list[str]],
            limits, outcome: Outcome) -> None:
    """Order the canonical voices for numbering: stable appearances first.

    §6 of the brief. Numbering used to run on first appearance of any kind, so a
    half-second fragment the provider mislabelled at 00:17 took `Speaker 2` and
    pushed every real participant along behind it — and because the fragment was
    below the embedder's floor there was never any evidence it was a person at
    all.

    A voice is *stable* here when it has region audio above the reference floor:
    enough for the embedder to have answered, and enough to have been compared
    to everybody else. Those are ordered by when they were first heard. A label
    with nothing but fragments keeps its identity — the provider said somebody
    spoke and this module does not overrule that on silence — but it is numbered
    after the people the meeting can actually hear, so it cannot renumber them.
    """
    stable, thin = [], []
    for head in groups:
        cluster = clusters[head]
        target = stable if cluster.seconds >= limits.reference_floor_seconds else thin
        target.append(cluster)
    stable.sort(key=lambda cluster: cluster.first_at)
    thin.sort(key=lambda cluster: cluster.first_at)
    outcome.order = [cluster.key for cluster in (*stable, *thin)]
    for head, members in groups.items():
        for name in members:
            outcome.mapping[name] = head
