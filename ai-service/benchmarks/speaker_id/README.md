# Speaker identification benchmark

Measures the shipped ECAPA matcher against real human voices. It changes
nothing: the accept threshold, the margin and the minimum-speech rule are read
from `app.voiceprints.Thresholds` and every decision is made by
`match_speakers` itself.

The question it exists to answer is not "does it work" but **how often does it
put somebody's name on somebody else's voice**, because that is the failure the
user cannot see. *John labelled Cindy* is far worse than *Cindy left as
Speaker 2*: the second is visibly unfinished and invites the manual fix, the
first is presented as a fact, written into the retrieval passages, and comes
back out of chat with a citation under it.

---

## Before you record anybody

**Ask.** These are voice recordings of identifiable people, and the embeddings
derived from them are biometric-adjacent under the same argument
`docs/speaker-identification.md` makes about the product. Everybody who records
for this should know what it is for and be able to have their files deleted.

**Nothing is committed.** `benchmark-audio/` is gitignored (`.gitignore:43`).
Do not move these files anywhere else, do not attach them to an issue, and do
not put a real name in a filename — the speakers are `p01`, `p02`, and the
mapping, if you need one at all, stays out of the repository.

**Nothing leaves the machine.** The harness runs locally in the ai-service
container. No audio is uploaded, and no embedding is written to disk: the CSV
carries a 12-character one-way fingerprint of each vector, which is enough to
notice that two rows are secretly the same file and not enough to be an
embedding.

---

## Where the files go

    <repo>/benchmark-audio/speakers/

Create it if it does not exist. Everything in it is ignored by git.

## Naming

    <person>_<role>_<device>_<environment>_d<day>_<seconds>s_<take>.<ext>

| field | values | why it is in the name |
|---|---|---|
| `person` | `p01`, `p02`, ... | pseudonymous; a report about voices should not also be a list of names |
| `role` | `enrol` \| `test` | `enrol` builds the profile, `test` is what gets identified |
| `device` | `laptop` \| `phone` \| `headset` \| `earbuds` \| `external` | the microphone effect is question 6 |
| `environment` | `quiet` \| `noisy` | so is the room |
| `day` | `d1`, `d2`, ... | a recording session; same-session pairs flatter the model |
| `seconds` | `6s`, `10s`, `20s`, `45s` | the length you aimed for |
| `take` | `01`, `02`, ... | unique within everything to its left |

    p01_enrol_laptop_quiet_d1_45s_01.wav
    p01_test_phone_quiet_d2_20s_01.m4a
    p02_test_headset_noisy_d3_6s_01.wav

There is no metadata file on purpose. A sidecar CSV saying who is in which
recording is one editing mistake away from labelling p03's voice as p04's, and a
benchmark whose ground truth is wrong does not fail — it reports a false-accept
rate that looks exactly like a real one.

`--check` validates every filename and reads no audio, so run it before you
record the whole set.

## How to record

**Different words every time.** Read something different in each take. Two
takes of the same sentence share prosody as well as a voice, and the score comes
out flattering.

**Talk continuously.** The harness treats each file as one span, so a ten-second
pause counts toward `usable_speech_seconds` where in a real meeting it would
not. Aim for speech end to end and trim leading and trailing silence.

**Aim slightly over.** A 20s target that lands at 18s is fine — the measured
length is what every calculation uses — but do not undershoot 6s, which is the
floor below which the matcher refuses to look at a candidate at all.

**Do not adjust anything between takes.** No noise suppression toggled on for
one and off for another, no moving closer to the mic because it sounded quiet.
The point is the conditions the product meets, not the best obtainable audio.

**Enrol on one day, test on another.** The single most flattering mistake in a
benchmark like this is recording everything in one sitting: two clips from one
session share a room, a microphone position and a voice that has not slept
since. Leave at least a day.

Any format ffmpeg reads (`wav`, `flac`, `m4a`, `mp3`, `webm`, `ogg`, `opus`).
Phone voice memos and browser recordings are ideal because they are what the
product actually receives.

---

## What to record

### Per person — the minimum

| # | file | notes |
|---|---|---|
| 1 | `pNN_enrol_laptop_quiet_d1_45s_01.wav` | the profile. Your usual laptop, quiet room, 45 seconds of continuous speech |
| 2 | `pNN_test_laptop_quiet_d2_20s_01.wav` | same mic, another day. The easy case, and the floor everything else is compared against |
| 3 | `pNN_test_phone_quiet_d2_20s_01.m4a` | phone voice memo, held normally |
| 4 | `pNN_test_headset_quiet_d2_20s_01.wav` | headset or earbuds |
| 5 | `pNN_test_laptop_noisy_d2_20s_01.wav` | laptop again, with a fan, a café, a TV — real noise, not a noise file |
| 6 | `pNN_test_laptop_quiet_d2_6s_01.wav` | a short one, at the 6-second floor |

Six files per person. That covers same-mic, laptop→phone, laptop→headset,
quiet→noisy, different days and different sentences.

### Worth adding, in this order

1. **A second enrolment session** (`pNN_enrol_phone_quiet_d3_45s_01.m4a`).
   Production profiles improve with each appearance, and a one-sample profile is
   the worst case rather than the normal one.
2. **A third session of tests** (`d3`), which is the only way to see whether
   same-person similarity is stable or whether `d2` was lucky.
3. **Explicit durations** (`10s`, `45s` takes) if you would rather measure the
   duration effect from independent recordings than from `--truncate`.

### Across people — the part that decides the answer

The false-accept rate is driven by the hardest pairs, not by the average, so
**who** you record matters more than how many:

- at least **two pairs of the same gender**;
- at least **one pair with a similar accent** — family members, colleagues from
  the same region;
- at least **one pair with a similar pitch or speaking style**, if you can find
  one;
- and some obviously different voices, which set the easy end of the scale.

Six people who all sound different will produce a reassuring number that says
nothing about the case the product fails on.

---

## Running it

The model and ffmpeg live in the ai-service image, and the ECAPA weights are
baked into `/opt/models/ecapa` at build time. The dev virtualenv deliberately
does not have torch, so this must run in the container:

```bash
docker run --rm \
  -v "$PWD/ai-service/benchmarks:/app/benchmarks:ro" \
  -v "$PWD/benchmark-audio/speakers:/audio:ro" \
  -v "$PWD/benchmark-audio/results:/out" \
  recallix-ai-service:latest \
  python -m benchmarks.speaker_id.run --audio /audio --out /out --truncate
```

On Windows under Git Bash, prefix with `MSYS_NO_PATHCONV=1` and use an absolute
path (`-v "d:/FullStackDevelopment/Recallix/ai-service/benchmarks:/app/benchmarks:ro"`).

Build the image first if you have not: `docker compose build ai-service`.

Check the filenames without loading anything:

```bash
docker run --rm \
  -v "$PWD/ai-service/benchmarks:/app/benchmarks:ro" \
  -v "$PWD/benchmark-audio/speakers:/audio:ro" \
  recallix-ai-service:latest \
  python -m benchmarks.speaker_id.run --audio /audio --out /tmp --check
```

### Flags

| | |
|---|---|
| `--check` | validate names and report coverage, then stop. No model, no audio read |
| `--truncate` | also evaluate 6s/10s/20s/45s prefixes of every test clip. Measures the duration effect from recordings you already have — the same take, cut shorter, so the only thing that changed is how much speech the model got |

### Output

| file | |
|---|---|
| `summary.md` | the report, also printed to stdout |
| `comparisons.csv` | one row per candidate × profile: the cosines the distributions are made of |
| `trials.csv` | one row per decision: what the matcher was offered, what it said, and which refusal fired |

---

## How each test clip is used twice

Every test clip is put to the matcher against two profile sets:

- **closed set** — everybody, including the clip's own speaker. The right answer
  is their own profile, so this is where *false rejections* come from.
- **open set** — everybody *except* their own speaker, so the right answer is
  that nobody matches. This is where *false accepts* come from.

That is leave-one-person-out, and it is why a small dataset still measures the
failure that matters: with N people, each test clip is a genuine trial *and* an
impostor trial rather than only the first. A person with no enrolment clip is
already an impostor against every profile, so only the closed run is emitted for
them.

---

## How much data before tuning anything

A rate is only as good as the number of trials under it. With zero failures in
*n* trials, the 95% upper bound on the true rate is about `3/n` — so the
question is how small a false-accept rate you need to be able to rule out.

| people | test clips each | genuine trials | impostor trials | cross-person comparisons | FAR you can rule out at 0 failures |
|---|---|---|---|---|---|
| 3 | 6 | 18 | 18 | 36 | ~17% — not a measurement |
| **6** | **6** | **36** | **36** | **180** | **~8%** |
| 10 | 6 | 60 | 60 | 540 | ~5% |
| 20 | 6 | 120 | 120 | 2,280 | ~2.5% |

**The minimum before touching a threshold: 6 people × 6 clips = 42 files**
(6 enrolment + 36 test). That is enough to see whether the current settings are
badly placed, to produce a same-person and different-person distribution with a
visible shape, and to name the hardest pair in each.

It is **not** enough to move 0.55 by 0.02 and claim an improvement. Below about
10 people, the difference between two nearby thresholds is one or two trials,
which is noise — and it is noise from your microphones, your rooms and your
accents, which is exactly what a threshold must not be fitted to.

Before tuning, the dataset also has to contain the hard cases. Twenty people who
all sound different measure less than six people among whom two are siblings.
The report names the hardest same-person and hardest different-person pair for
this reason: if the hardest different-person pair is comfortably below the
threshold, the dataset has not yet found the pair that matters.

---

## What this harness does not measure

- **The one-profile-per-speaker rule.** Each candidate is put to the matcher on
  its own, so refusals 1–3 (too little speech, below threshold, margin) are
  exercised and refusal 4 (a profile already claimed by a better candidate) is
  not. That is an assignment rule between speakers in one meeting, not a
  property of a voice.
- **Diarization.** Each file is one person by construction. Whether the product
  correctly separated two people in a real meeting is a different question, and
  `tests/test_diarization_eval.py` is where it lives.
- **Speech versus elapsed time.** In a meeting a speaker's spans exclude the
  parts where somebody else was talking. Here the span is the whole clip, so
  pauses count. The recording instructions above are what keeps the two close.
