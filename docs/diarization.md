# Speaker diarization: provider clusters, Recallix speakers

Two bugs were reported from real meetings. They turned out to be one mistake
seen from two ends — Recallix treated the provider's speaker label as if it
were a Recallix speaker number.

This is what was wrong, how it was measured, and what the fix does.

---

## 1. The short interjection that got swallowed

Someone talks for thirty seconds, someone else says "Exactly.", the first
person carries on. Recallix showed:

```
Speaker 1: We need to finish authentication … Exactly … then deploy staging.
```

**Root cause.** Modern diarization attributes **every word**, not only every
utterance. Recallix's parser read `utterance["speaker"]` and then dropped the
per-word `speaker` field on the way past — `_words_of` kept only text, start,
end and confidence. A speaker change *inside* an utterance was therefore
unrepresentable: the interjection was absorbed into whichever turn surrounded
it, and the evidence that would have shown otherwise had already been discarded.

**Whose bug?** Ours, on both paths, but for different reasons:

| Path | What the provider did | What Recallix did |
|---|---|---|
| Final (async) | Correct. Put "Exactly." on its own utterance, labelled B. | Discarded word-level labels, so a mid-utterance switch had nowhere to live. |
| Live (streaming) | Correct, but in **two messages**. | Read the wrong field on the second one, so the correction never arrived. |

The live case is the one users actually saw, and it is worth spelling out. The
provider sends a turn it has not yet clustered with `speaker_label: "PENDING"`,
then sends a `SpeakerRevision` naming it. Recallix read `message.turns`; the
wire field is `message.revisions`. **Every speaker revision was silently
discarded.** And `"PENDING"` fell through to the "it must be a real name"
branch, so the transcript showed turns spoken by somebody called *PENDING* —
marked `attributed`, so it read as an answer rather than a placeholder.

---

## 2. The second person to speak was "Speaker 4"

**Root cause.** AssemblyAI names voice clusters "A", "B", "C"… and Recallix
rendered them by alphabet position: `ord(label) - ord("A") + 1` in Python,
`charCodeAt(0) - 64` in TypeScript. A meeting whose two voices clustered as A
and D displayed **Speaker 1 and Speaker 4**, with no Speaker 2 or 3 anywhere —
which reads as two people missing from the room.

Those letters are cluster identifiers. Their ordering and their gaps say nothing
about the meeting; "D" does not mean "the fourth person". Deepgram had the same
shape with 0-based integers, so `speaker_label(3)` returned "Speaker 4" there
too.

**Whose bug?** Entirely ours. The provider never claimed those letters were
positions.

---

## 3. How it was measured

Section 31 of the brief asks for a diagnostic that says whether a mislabel came
from the provider or from Recallix. That question was answered before any
parsing changed, because the answer decides what can be fixed and where.

Two Windows TTS voices — one male, one female, so acoustic separation is not in
question — were recorded separately and spliced, giving a 32.7-second file with
**exactly known** speaker boundaries:

```
  0.00-18.34  voice A   (long continuous turn)
 18.34-19.83  voice B   "Exactly."
 19.83-26.02  voice A
 26.02-28.25  voice B   "Yes, I agree."
 28.25-32.71  voice A
```

**Async, with and without `speakers_expected: 2`** — five utterances, correct
labels, the one-word interjection on its own with its own label, zero words
disagreeing with their parent utterance. The provider was right both times.

**Streaming** — seven turns, and the two interjections arrived as
`speaker_label: "PENDING"`, corrected to `"B"` by a single `SpeakerRevision`
message. The provider was right here too; Recallix was not reading the
correction.

Neither benchmark file is committed (`benchmark-audio/` is gitignored) and
neither is needed to run the test suite — the regression tests construct the
shapes directly.

---

## 4. Data flow, before and after

### Before

```
AssemblyAI utterances[]           AssemblyAI words[]
   speaker: "A"                      speaker: "A" | "B"   ← discarded
        │                                   │
        ▼                                   ✗
   ord("A") - ord("A") + 1  →  "Speaker 1"
   ord("D") - ord("A") + 1  →  "Speaker 4"
        │
        ▼
   Segment{ speaker: "Speaker 4" }   ← speaker_status computed, then dropped
        │                               at the AiSegment boundary
        ▼
   transcript_segments.speaker = "Speaker 4"
        │
        ├──▶ transcript      ─┐
        ├──▶ speaker %       ─┤
        ├──▶ colour (hash of ─┤  all keyed on a display string that
        │      display name)  │  changes when somebody is renamed
        ├──▶ exports         ─┤
        └──▶ RAG passages    ─┘
```

### After

```
AssemblyAI utterances[]  +  words[]  (both, per word)
        │
        ▼
   raw_token()          → "A" | "D" | None      (normalise, assign nothing)
        │
        ▼
   split_by_speaker()   → runs, split only where the provider changed label
        │
        ▼
   CanonicalSpeakers    → first appearance wins:  D→spk_1, A→spk_2
        │
        ▼
   Segment{ speaker: "Speaker 1", speaker_key: "spk_1",
            speaker_raw: "D",     speaker_status: "attributed",
            words: [ …, speaker, speaker_raw ] }
        │
        ▼
   transcript_segments (+ speaker_key, speaker_raw, speaker_status — V46)
        │
        ├──▶ transcript      ─┐
        ├──▶ speaker %       ─┤  grouped by speaker_key
        ├──▶ colour          ─┤  hashed from speaker_key, so a rename
        ├──▶ exports         ─┤  does not recolour anybody
        └──▶ RAG passages    ─┘
```

The live path mirrors it in `frontend/lib/canonical-speakers.ts`, because the
live transcript cannot wait for a server round trip to know what to call
somebody. The final transcript renumbers from scratch, so a live disagreement
cannot survive into the saved meeting.

---

## 5. Canonical numbering

Assigned by **first chronological appearance**, meeting-locally:

```
provider   A  A  D  D  A  F
canonical  1  1  2  2  1  3
```

Properties that are load-bearing, each with a test:

- **Deterministic.** No clock, no hash, no sorting. Reprocessing the same
  provider response produces the same mapping. Callers feed it in chronological
  order, which is why the parsers resolve as they walk rather than afterwards.
- **Stable within a meeting.** A number, once assigned, holds. It survives a
  websocket reconnect, which matters because the provider restarts its letters
  from "A" on a new session.
- **An unknown speaker does not consume a number.** Otherwise one unlabelled
  turn early on shifts everybody after it by one.
- **A real name outranks a number.** Speaker identification returning "Cindy"
  yields `spk_1` / "Cindy", and the next unnamed voice is Speaker 2 rather than
  colliding with her.

### The three names a speaker has

| | Example | Changes when |
|---|---|---|
| `speaker_raw` | `"D"` | The provider re-clusters. Never displayed. |
| `speaker_key` | `"spk_2"` | Never, within a meeting. |
| `speaker` | `"Speaker 2"` → `"Sarah"` | A user renames. |

Renames overwrite the display name only, so the key still picks the colour —
which is why renaming Speaker 2 to Sarah no longer changes her colour. The
hierarchy is **manual name > provider-identified name > canonical Speaker N**.

---

## 6. What this deliberately does not do

No heuristic infers a speaker from the words. Specifically absent:

- pause length as a speaker-change signal;
- "short replies belong to the other person";
- alternating speakers after a question;
- any LLM asked who was talking.

Every boundary traces back to an explicit provider attribution, and where the
provider declines to attribute, so does Recallix. Diarization is an acoustic
task; a heuristic that reads well in a demo invents speakers in a real meeting,
which is worse than the provider's own mistake because it is confident and it
is ours.

The one text-level liberty taken is sentence-casing the first word of a
fragment that begins mid-sentence *because it was split out* — otherwise
"…and monitor production." reads as a broken line rather than as a turn. It is
skipped where the first word has an interior capital, so "iPhone" does not
become "IPhone".

---

## 7. Speaker constraints, and how Auto behaves

Verified against the current API.

**Async.** Recallix sends `speakers_expected` when the exact count is known and
`speaker_options{min,max}` for a range — never both, which the provider rejects
with a 400. The count comes from the import dialog's *Expected speakers* control
(Auto / 2 / 3 / 4 / 5 / custom range, V45), never from a calendar attendee count:
four people invited is not four people who spoke.

**Auto means the provider's own ceiling applies**, which is documented as:

| Audio duration | `max_speakers_expected` default |
|---|---|
| 0–2 min | unspecified |
| 2–10 min | 10 |
| 10+ min | **30** |

A 30-wide search on a two-person meeting is the documented way one person
fragments across several labels. Recallix does **not** currently override this,
and that is a deliberate abstention rather than an oversight: capping it would
merge real speakers past the cap ("additional speakers are merged into existing
labels"), and no measurement is available here to say which harm is larger. The
effective constraint is logged per job as `speaker_constraint`, so a bad job can
be attributed to it rather than guessed at.

**Streaming.** `max_speakers` (1–10) and `mode` (`max_accuracy` / `min_latency`
/ `balanced`, default `balanced`) are both available and neither is currently
sent. Benchmarked on the spliced file: baseline, `max_speakers=2`, and
`mode=max_accuracy` produced **byte-identical diarization** — two labels, zero
misattributed interjections, one revision message. There is no measured
improvement to justify changing the default, and section 21 asks for benchmark
evidence before enabling anything. Recording currently has no place to state a
speaker count, so live always runs Auto; import does, and it reaches the async
job.

---

## 8. The diarization trace

`app.diarization.trace_lines` renders raw beside canonical, per word:

```
00:10.20  "we"       raw=A  canonical=Speaker 1
00:11.02  "exactly"  raw=D  canonical=Speaker 2
```

This is the view that settles whose bug a mislabel is. If the provider said B
and the canonical column says Speaker 1, the fault is in `app/diarization.py`.
If the provider itself said A, no remapping will fix it and the answer is
expected-speaker constraints or better audio.

It prints transcript content, so it is gated on the adapter logger's DEBUG
level — off in every deployment that has not deliberately turned it on, absent
from the structured telemetry, and covered by a test asserting that INFO stays
clean.

Non-sensitive diagnostics are always on, in the `assemblyai.job` log line:
`diarization_map` (provider label → displayed label, letters and numbers only),
`speaker_constraint`, `speaker_count`, `unattributed_segments`, `model_used`.

> `model_used` falls back to the first requested model: a v2 response to a
> `speech_models` request does not echo `speech_model` back, verified against
> the live API.

---

## 9. Migration

`V46__canonical_speakers.sql` adds `speaker_key`, `speaker_raw` and
`speaker_status` to `transcript_segments`.

Transcripts written before it keep NULL identity columns, deliberately rather
than by backfill: their `speaker` strings came from the old alphabet-position
mapping, so any key invented for them now would be guessing which voice was
which. Readers fall back to the display name — exactly how those transcripts
behaved before — and reprocessing a meeting fills the columns in properly.

`SpokenWord` gained `speaker` and `speakerRaw` without a migration: words are
stored as JSONB, and rows written by the older shape read back with both null.

---

## 10. When the provider merges two people

Sections 1 and 2 were about Recallix mishandling what the provider said.
This one is about the provider being wrong, which needs a different answer.

### The report

```
Speaker 2 (00:22)  "Okay, you have a good day anyway. I'm going home.
                    All right, Mr. Bob, I'll come see you when I get off.
                    Just want to give y'all a little update on Mr. Bob..."
```

Two people. The first sentence ends one person's call; everything after it is
the other one, starting a new thought.

### Whose bug, measured

The diagnostic in section 8 exists for exactly this question, and the answer was
unambiguous. The audio was re-submitted to AssemblyAI four ways:

| Request | Result at 22.00-32.26 |
|---|---|
| As Recallix sends it today | one utterance, speaker `B` |
| `speakers_expected: 2` | one utterance, speaker `B` |
| `speaker_options{min: 2, max: 2}` | one utterance, speaker `B` |
| `universal-2` instead | one utterance, speaker `B` |

**Every word was labelled `B`** in both the `utterances` array and the top-level
`words` array. Recallix's parser was faithful; there was nothing in the response
to recover, and `split_by_speaker` had nothing to split on.

Speaker constraints did not help, and it is worth being clear why: the provider
had already found exactly two speakers. It was not searching too wide (section
7) — it put a boundary in the wrong place, which no count can express.

### Why the obvious repairs are wrong

**A pause.** The provider's own word timings put "home." ending at 25.14 and
"All" starting at 25.14 — a gap of exactly zero. Silence would have missed this
one, and section 6 rules pause length out anyway. This recording is the reason
that rule is right rather than merely cautious.

**The text.** "I'm going home." followed by "All right, Mr. Bob" reads like a
handover to a person and like a continuation to a rule. Every text heuristic
that gets this case right invents boundaries elsewhere, confidently.

### What it does instead

Since V53 Recallix has a speaker embedding model of its own (see
[speaker-identification.md](./speaker-identification.md)). `app/rediarize.py`
uses it to ask one question of each suspiciously long turn: *does the audio
actually stay with one person?*

Measured on the reported recording, through the real modules:

```
reference separation cos(A,B) = +0.2711   (the two voices are distinguishable)

the disputed turn, 22.00-32.26, provider says B throughout:
  22.00-25.14   cos(A)=+0.1271  cos(B)=+0.5625  -> B
  25.14-32.26   cos(A)=+0.5687  cos(B)=+0.2213  -> A
  cos(left, right) = +0.0652

blind scan, 0.5s steps, told nothing about the answer:
  best split at t=25.00        truth = 25.14
```

The scan has a clean unimodal peak at the right place, and a control turn the
provider got right (32.26-39.16) scores both halves as the same speaker, so
nothing is proposed there.

End to end through the pipeline, the same audio now produces:

```
22.00-25.14  Speaker 2  Okay, you have a good day anyway. I'm going home.
25.14-32.26  Speaker 1  All right, Mr. Bob, I'll come see you when I get off...
```

### The rules, and why they are all refusals

A false split is a **new** failure mode, and worse than the bug it repairs: a
missed boundary leaves two sentences under one name, which a reader can see and
correct, while an invented boundary puts words in somebody's mouth in a
transcript that now looks more carefully attributed than it is.

- Only turns of **6 seconds or more** are examined.
- References come from each speaker's **shortest** turns, capped — the opposite
  of how a voice profile is built, and deliberately: a two-second turn cannot
  conceal a ten-second one, so short turns are the *safe* evidence.
- Both sides of a split must land on **different speakers who are already in the
  meeting**, each clear of the runner-up by a margin, and the two sides must be
  dissimilar to each other.
- **No speaker can be invented.** Only labels the provider already used may be
  assigned, so canonical numbering, colours, talk-time and voice profiles are
  untouched by a repair.
- If the meeting's own speakers are not far enough apart in the embedding space,
  **nothing is attempted anywhere in that recording** — the model cannot tell
  these voices apart, so every split would be a coin toss with a confident face.
- Any failure — no model, no audio, an embedder that throws — leaves the
  provider's segmentation exactly as it was.

### The two thresholds are tied together

A turn is either short enough to trust as reference audio or long enough to be
suspected of hiding somebody, and nothing is both. Lowering the examine
threshold therefore also shrinks the reference pool, and below about six seconds
a two-person recording of this shape stops having enough safe audio for one of
its speakers — at which point the feature correctly disables itself rather than
guessing. That is the floor, and it is why a **4.85-second merged turn later in
this same recording is left alone**: it is real, it is the same bug, and it is
below the line where the evidence is good enough to act on.

---

## 12. A second, acoustic diarizer — evaluated, and left off

Section 10's repair works inside the provider's answer: it can move a boundary
the provider drew and it can reassign a turn to a speaker the provider already
found. It cannot invent a speaker the provider missed, and it cannot look at a
turn shorter than six seconds. Both are structural, so the question was whether
a real diarization model — audio in, speaker timeline out, no transcript
involved — should sit behind the provider's labels instead.

It was built, benchmarked and **left switched off**, because the benchmark said
so. `DIARIZATION_PROVIDER` defaults to `none`.

### What was built

| Module | Job |
| --- | --- |
| `app/diarize_port.py` | `DiarizationPort`: audio → `Timeline`, and nothing else |
| `app/providers/pyannote_diarizer.py` | pyannote Community-1 behind that port |
| `app/reconcile.py` | each word to whoever held most of it, by overlap |
| `app/reattribute.py` | a reconciliation written back as segments |
| `app/diareval.py` | attribution, cpWER, missed/false boundaries |

Words are matched to the timeline by **maximum temporal overlap**, not by
looking up the speaker at `word.start`. Word timings and diarization boundaries
come from two different models and never agree to the millisecond, so a
start-timestamp lookup is wrong exactly at boundaries — which is where every
error already is.

### Which model, and which were rejected

- **pyannote Community-1** — MIT, gated on Hugging Face. Chosen.
- **`nvidia/diar_sortformer_4spk-v1`** — ungated and capable, but **CC-BY-NC**.
  It cannot ship in a commercial product, so it was not evaluated further.
- **pyannote Precision-2** — a paid API. Not introduced silently.

Every pyannote checkpoint returns **HTTP 401** unauthenticated. Enabling this
needs `pip install pyannote.audio`, an account that has accepted the model's
terms, and `HF_TOKEN` in the environment. Without any of those the port reports
itself unavailable, and a meeting processes exactly as it does today.

### Benchmark 1: ground-truth audio, where the truth is exact

105 seconds, two Windows TTS voices spliced at known boundaries — including a
0.42s "Good.", a 0.65s "I agree.", zero-pause handoffs and a 33s monologue that
must not be split. Media is not committed; see the generator note in
`docs/` history and rebuild it locally.

| System | Attribution | cpWER | Missed | False |
| --- | --- | --- | --- | --- |
| A. AssemblyAI raw | 100.0% | 0.0% | 0 | 0 |
| B. Recallix today | 100.0% | 0.0% | 0 | 0 |
| C. SpeakerRefiner | 100.0% | 0.0% | 0 | 0 |
| D. Reconciliation | 100.0% | 0.0% | 0 | 0 |

Community-1 placed every boundary, including the sub-second turns the section 10
refiner cannot reach. So the model works. But **AssemblyAI is already perfect on
this audio**, so there is nothing here to win — a clean, two-voice, well-separated
recording is not where the provider fails.

### Benchmark 2: the recording this work was commissioned for

A phone call captured through a speaker, with a narrator layer. 296 words.

- Community-1 reported **no speech at all across 14.1 seconds** covering **62 of
  296 words** (21%) that AssemblyAI transcribed. Not a gain problem: `loudnorm`
  and `highpass+dynaudnorm` both failed to recover it, and `loudnorm` made it
  worse (two speakers collapsed to one). The 26–40s stretch returns 0.0s of
  speech even when it is the entire file.
- Of the 13 words it did move, **11 sat within 1.3s of a boundary the provider
  had already drawn** (median 0.74s). That is boundary jitter, not discovery.
- Run end to end, it splits `"Yes, sir."` into `Speaker 1: "Yes,"` /
  `Speaker 2: "Sir."`, tears `"thing."` off its sentence, and carves a 0.38s
  `"I just"` out of the middle of one. It also **undid** a correct section 10
  repair, putting the narration back on the wrong speaker.

The honest conclusion: this recording's two voices arrive down one heavily
compressed telephone channel. Acoustic diarization keys on channel and timbre,
and here the channel is identical for both people. The model is not broken; this
audio defeats it, and Recallix's users record a lot of audio like it.

### The rule that came out of it

Silence is not a verdict. Where the diarizer heard nothing it has not
disagreed with the provider — it has said nothing, and those are different
things. So `app/reconcile.py` uses an explicit precedence:

- the diarizer heard speech → its answer wins, contradictions included;
- it heard **nothing** → the provider's label stands, translated into the same
  key space by time overlap alone;
- it heard speech but cannot say whose → **unresolved**, and no fallback.

That last case deliberately does not fall back. Silence means no opinion; an
ambiguous boundary means an opinion that is not safe to act on, and handing it
back to the provider would return the very boundary the diarizer was brought in
to second-guess.

Without this rule the first real recording lost the speaker of 73 of 296 words,
which is worse than shipping nothing.

### Cost, if it is ever turned on

Community-1 runs at roughly **4.5× realtime on CPU** in this image — a
60-minute meeting is about four and a half hours. It would need a GPU, or to be
a separate queue, before it could be on by default for anyone.

### Reproducing this

```bash
pip install pyannote.audio            # not in requirements.txt; ~2GB with deps
export HF_TOKEN=hf_...                # account must have accepted the terms
export DIARIZATION_PROVIDER=pyannote
```

`tests/test_reconcile.py`, `tests/test_reattribute.py` and
`tests/test_diarization_eval.py` cover the join, the write-back and the
comparison; none of them need the model, because the behaviour that matters is
a pure function of times.

## 11. Known limitations

- **Live and final can disagree mid-meeting.** They are separate mappings by
  design. The final job renumbers from its own chronology and replaces the live
  transcript wholesale, so the disagreement never reaches the saved meeting.
- **Renaming happens after finalization only**, so there is no live rename to
  reconcile against final speakers. This is the simpler model and it is
  preserved; if renaming during a recording is ever added, matching by number
  alone would be wrong and overlapping timestamp ranges would be the place to
  start.
- **`speakers_expected` can no longer be set by anybody.** The import dialog was
  the only control that offered it, and it was removed: the value reaches the
  provider as a hard constraint, so a wrong guess merges two people into one or
  splits one across two, and its own help text recommended leaving it on "work
  it out". A control whose best answer is "do not touch me" is not a control.
  `expectedSpeakersMin`/`Max` are still accepted by `POST /meetings` and still
  travel on the event; nothing sends them, so every job now runs on the
  duration-based defaults in section 7.
- **Named speaker identification is now wired, and not by the provider.**
  It was not, for a long time, and the reason is worth keeping: known speakers
  (V20) held a name, a use count and a date, fed prompting and keyterms, and
  were never a voiceprint — that feature could not have identified anybody, and
  it is gone (V51). Neither transcription provider offers cross-file speaker
  identity either; AssemblyAI documents that it does not and points at exactly
  the approach Recallix now takes. Speakers are still numbered by who spoke
  first and can still be renamed by hand; a rename is now also what teaches a
  voice, for accounts that have opted in. See
  [speaker-identification.md](./speaker-identification.md). The adapter will
  still pass a provider-returned name through as a label if one ever arrives.
- **Auto leaves a 30-speaker search space on recordings over ten minutes.** See
  section 7.
- **A merged turn shorter than six seconds is not repaired.** Section 10 explains
  why the floor is where it is: the same threshold that decides what to examine
  decides what may serve as reference audio, and below it there is not reliably
  enough safe audio to judge against. The reported recording contains one such
  turn, at 57.34, and it is left as the provider gave it. Section 12 records
  what happened when a real diarization model was pointed at that same turn: it
  did not fix it either, and split `"Yes, sir."` across two speakers on the way
  past.
- **Overlapping speech cannot be represented.** One `speaker` per word is the
  schema, and there is nowhere to put a second. Where the diarizer offers an
  `exclusive_speaker_diarization` it is preferred, so the overlap is resolved by
  the model that heard it rather than by a tie-break downstream, and how much was
  resolved away is kept on `Timeline.overlap_seconds`. Two people talking at once
  still end up attributed to one of them.
