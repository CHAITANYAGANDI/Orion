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

## 10. Known limitations

- **Live and final can disagree mid-meeting.** They are separate mappings by
  design. The final job renumbers from its own chronology and replaces the live
  transcript wholesale, so the disagreement never reaches the saved meeting.
- **Renaming happens after finalization only**, so there is no live rename to
  reconcile against final speakers. This is the simpler model and it is
  preserved; if renaming during a recording is ever added, matching by number
  alone would be wrong and overlapping timestamp ranges would be the place to
  start.
- **`speakers_expected` cannot be set for a recording**, only for an import.
- **Named speaker identification is not wired.** It never was: known speakers
  fed prompting and keyterms and were never a voiceprint, and that feature is
  gone (V51). Speakers are numbered by who spoke first and renamed by hand. The
  adapter will still pass a provider-returned name through as a label if one
  ever arrives.
- **Auto leaves a 30-speaker search space on recordings over ten minutes.** See
  section 7.
