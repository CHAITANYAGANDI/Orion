# Recognising a voice in a later meeting

Meeting A has *Speaker 1* and *Speaker 2*. You tag Speaker 2 as **Sarah**.
Weeks later, meeting B has *Speaker 1* and *Speaker 2*, and one of them is
Sarah. Pressing **⋯ → Rematch speakers** should find her.

This is what it took to make that true, and the several ways it could have been
faked instead.

---

## 1. Why the old feature could not have worked

Recallix shipped a `known_speakers` table in V20. It stored:

```
display_name    times_used    last_used_at
```

That is an autocomplete list. It made typing "Sarah" for the fourth time
quicker, and it could not have identified anybody, because **a name is not a
voice**. It was dropped in V51 along with the rest of that feature.

Meanwhile the menu item labelled "Rematch speakers" did not call any endpoint at
all. It switched to the Transcript tab, opened the rename form, and scrolled to
it. The endpoint that *was* called `rematch` — `PATCH /speakers/rematch` — did
something else again: merge one label into another, or move selected turns.
Not what any other product means by the word. That capability has since been
removed outright — the answer to a diarization that came out wrong is now
**Reprocess meeting**, which re-runs the clustering, rather than asking a reader
to repair it turn by turn.

So there were three things wearing two names, and the acoustic capability that
would have justified the third did not exist.

## 2. What was ruled out

Each of these looks like it would work and is a guess in a confident voice.

**Matching speaker numbers across meetings.** Numbers are assigned by first
chronological appearance, meeting-locally (see [diarization.md](./diarization.md)
§5). The only thing *Speaker 2* in March shares with *Speaker 2* in January is
who happened to clear their throat first.

**Using the provider's cluster labels.** "A", "B", "D" are per-request cluster
identifiers. AssemblyAI documents that they carry no meaning across files.

**Reading the transcript.** "Thanks, Sarah" identifies who was *spoken to*, not
who was speaking, and gets the answer backwards about as often as not.

**Asking a language model.** It has never heard the audio. It will answer
anyway, fluently, and the answer will be a plausible reading of the words.

**Assuming Speaker 1 is always the account holder.** True often enough to be
dangerous and false often enough to matter.

There is exactly one honest way to know whether two recordings contain the same
voice, and it is to compare something derived from the sound.

## 3. What the providers actually offer

Checked against current documentation rather than assumed.

| | Diarization | Cross-file identity |
|---|---|---|
| **AssemblyAI** | Yes, word-level | **No.** Its "Speaker Identification" is per-file: it maps that file's diarized labels onto a list of names you supply, using in-file context. There is no enrolment and no voiceprint. |
| **Deepgram** *(evaluated, no longer used)* | Yes | **No.** Labels do not persist across requests. Kept in this table because it is evidence for the conclusion below: no transcription provider offers cross-file identity, which is why Recallix owns this piece. |
| **OpenAI Whisper** | No | No |

AssemblyAI's own FAQ on the subject recommends the approach taken here: get
diarization from them, *"use a model like Nvidia Titanet to generate speaker
embeddings from the audio, then match these embeddings against a vector database
of known speakers."*

So this is a capability Recallix has to own. It cannot be bought from the
transcription provider, and no configuration flag turns it on.

## 4. The model

`speechbrain/spkrec-ecapa-voxceleb` — ECAPA-TDNN trained on VoxCeleb, 192-dim
embedding per utterance, running on CPU.

Chosen over an ONNX export of the same architecture for one reason: **the
front-end travels with the weights.** A speaker embedding is only as good as the
filterbank feeding it, and a mel front-end that is subtly wrong — off-by-one
window, wrong normalisation, wrong scale — does not fail. It produces embeddings
that are still 192 numbers and still compare to each other. That failure looks
exactly like the feature working, right up until somebody is renamed to the
wrong person.

**The cost is real and is not hidden.** The ai-service image goes from **241 MB
to 1.91 GB**: torch, torchaudio and the model. The alternative was not a smaller
version of this capability but a plausible-looking one.

torch and torchaudio are pinned to the same minor and installed from the PyTorch
CPU index. Both matter: the default Linux wheel bundles the CUDA runtime, and
torchaudio is in maintenance and no longer tracks torch's releases, so an open
range gives torch 2.13 beside torchaudio 2.11 — which installs cleanly and then
throws `OSError: Could not load this library: _torchaudio.abi3.so` at first
import. The model is baked in at build time so the first rematch of a deployment
is not also the slowest one.

Audio is decoded through **ffmpeg** on stdin/stdout to 16 kHz mono PCM. Nothing
is written to disk; the waveform exists in memory for the length of one call.

## 5. The pipeline

```
   rename                                    rematch
      │                                         │
      ▼                                         ▼
  Spring: consent?  ─── no ──▶ nothing      Spring: consent? ── no ──▶ "turn it on"
      │ yes                                     │ yes
      ▼                                         ▼
  turns by speaker_key                      turns by speaker_key
  (never by display name,                   + which labels are still
   never unattributed)                        placeholders
      │                                         │
      └──────────────▶ ai-service ◀─────────────┘
                            │
                  fetch audio by object key
                            │
                  ffmpeg ▶ 16 kHz mono PCM
                            │
                  choose spans: longest first, ≥0.8s each, ≤45s total
                            │
                       ECAPA-TDNN ▶ 192 floats
                            │
                   Fernet ▶ meeting_speaker_voiceprints
                            │
        ┌───────────────────┴───────────────────┐
        ▼                                       ▼
   learn: average into                    identify: cosine against
   speaker_profiles                       every profile, apply the
   (the ONLY writer)                      four refusals
                                                │
                                                ▼
                                     Spring applies by speaker_key,
                                     rebuilds the flat transcript,
                                     re-indexes pgvector, marks the
                                     summary stale
```

**Only a rename writes a profile.** Identification reads and never enrols. That
asymmetry is load-bearing: if identification could also enrol, one confident
mistake would be averaged into Sarah's profile and make the next mistake
likelier — a loop that degrades silently, because every individual step looks
like the feature working.

**Why span selection is not "the first 45 seconds".** Longest turns first, then
back into chronological order. Taking the first N seconds over-weights whatever
happened at the top of the meeting, which is often somebody reading an agenda in
a different register. And a one-word interjection is disproportionately likely,
at a handover, to be the tail of the *other* speaker's word — diarization is
least certain exactly where turns are shortest.

## 6. When a match is allowed to happen

Four refusals, in `ai-service/app/voiceprints.py`. There is no rule anywhere
that makes a match *more* likely.

1. **Too little speech.** Below `speaker_min_speech_seconds` (6.0) a candidate
   is not compared against anything. Not merely less accurate: a short sample
   drifts toward the middle of the embedding space, so it is *plausibly close to
   everybody* — the worst possible input to a nearest-neighbour rule.
2. **Not similar enough.** Best profile must clear `speaker_match_threshold`.
3. **Not distinctly the best.** Best must beat the runner-up by
   `speaker_match_margin`. This, not the threshold, is what handles two
   colleagues who genuinely sound alike: both can clear the bar, and when they
   do, the honest answer is "one of these two" — which cannot be said in a
   transcript, so nothing is said. The runner-up is measured against *every*
   profile including ones another candidate will win, because the ambiguity is a
   property of the voice, not of the assignment order.
4. **One profile, one speaker.** A profile is claimed at most once per meeting.
   A candidate that loses it to a better match is **not** given its second
   choice — that would be answering "who else could this be?".

Plus, on both sides of the wire: a speaker whose label is not one Recallix
generated is never touched.

### The asymmetry all of this serves

Renaming *Speaker 2* to *Sarah* when it was not Sarah is far worse than leaving
*Speaker 2* alone. A wrong name is put in front of the user as a fact, written
into the retrieval passages, and read back out of chat as *"Sarah said we would
ship on Friday"* with a citation under it. There is no way to tell that from a
true answer. An unresolved speaker is visibly unfinished, and is the state the
user was already in.

### The thresholds, and what calibrates them

Defaults: `accept=0.55`, `margin=0.08`, `min_seconds=6.0`.

Measured on two Windows TTS voices (male/female), each saying a different script
at a different speaking rate, embedded through the real code path:

```
same speaker, different script + rate:   0.9485, 0.9539
different speaker:                       0.1267, 0.1367, 0.1848, 0.1907
separation (worst same − best different): +0.7578
```

**That gap is much wider than real speech will give**, and this measurement
calibrates nothing — two synthetic voices of opposite gender are the easy case.
What it demonstrates is that the mechanism works end to end: decode, embed,
encrypt, store, retrieve, compare.

For the actual threshold: SpeechBrain's own verification example treats roughly
0.25 as the same-speaker line for this checkpoint on human audio. 0.55 sits well
above that. Erring high is the correct direction, and the margin check is what
does the real work on hard cases.

**No calibrated confidence is exposed anywhere.** Cosine similarity is the right
quantity to threshold on and is not a probability: 0.71 does not mean "71%
likely to be Sarah", and the mapping depends on the model, the recording
conditions and how much speech went into each side. It is logged and tested;
the user is told a count.

## 7. Privacy

A 192-number embedding is not audio and cannot be turned back into audio. That
is not a reason to relax. It is a stable identifier derived from a person's
body, it is the specific thing that makes one recording of them linkable to
every other, and under GDPR Article 9 a template used to identify a natural
person is biometric data whether or not it is reversible.

The full statement is in `V53__speaker_profiles.sql`. In short:

| | |
|---|---|
| **Off by default** | `users.speaker_learning_enabled` is `NOT NULL DEFAULT FALSE`. Every account existing when V53 ran has it off. While off, **no embedding is computed** — not merely not stored. |
| **Only a human enrols** | A profile is created when the user renames a speaker to a real name. There is no background enrolment, and identification never writes. |
| **Encrypted at rest** | Fernet (AES-128-CBC + HMAC-SHA256), key from `SPEAKER_PROFILE_KEY`. Stored as `BYTEA`, not `vector(192)` — see below. |
| **Fail-closed** | No key ⇒ the feature is off, not on and unencrypted. |
| **Per-account** | Both tables carry `user_id` under FORCEd row-level security with **no system bypass**, so no future endpoint can acquire one by accident. Profiles are never pooled, shared or used to train anything. |
| **Deletable** | One profile, or all of them. Switching learning off deletes everything held — withdrawal of consent removes the data, not just its use. Erasing a recording erases the voiceprints derived from it. Deleting a meeting or an account cascades. |
| **Never logged** | No waveform, no embedding, no ciphertext, no key. Enforced by a test that parses every logger call in the three modules and checks its arguments. |

### Why `BYTEA` and not `vector(192)`

pgvector would let Postgres do the nearest-neighbour search. It would also mean
the templates sit in the database in directly usable form, readable by anything
holding a connection or a base backup.

Matching happens in the ai-service instead, over a handful of decrypted vectors
held in memory for one request. The search is linear — a user has tens of
profiles, not millions — so it costs nothing, and it buys the property that the
key and the data are not in the same place.

### What is not claimed

The ciphertext protects the vector at rest and in backups. It does **not**
protect it from an attacker who already has the running service's memory or its
key. And there is no key rotation: re-keying orphans the old rows, which are
then ignored and recomputed. That is the honest position for a first version
rather than a rotation scheme that has never been exercised.

Spring never sees a vector at all. The `embedding` column is **not mapped** on
the `SpeakerProfile` entity — the privacy boundary there is enforced by absence
rather than by discipline, so there is no field to leak into a response, a log,
an export or a debugger.

## 8. Verified end to end

Two spliced TTS meetings with known boundaries, through the real HTTP API, the
real model and the real database:

```
meeting A:  spk_1 = David (0.0-23.1)    spk_2 = Zira (23.2-45.9)
meeting B:  spk_1 = Zira  (0.0-24.2)    spk_2 = David (24.2-40.0)
```

Zira is "Sarah", and she is **spk_2 in A but spk_1 in B** — so a match on
speaker number would give the wrong answer.

| Step | Result |
|---|---|
| Rematch with learning off | `unavailable: "Turn on speaker matching in Settings…"` |
| Turn on; rematch with no profiles | `matched: 0, considered: 2, unavailable: null` |
| Name Speaker 2 "Sarah" in A | profile created, `samples: 1`, 1124 bytes of Fernet ciphertext |
| Cached voiceprints after learning | one row: A/`spk_2`, 22.7s — **not** David, whom nobody named |
| **Rematch meeting B** | **`matched: 1, names: ["Sarah"], considered: 2`** |
| Meeting B transcript | `spk_1 → Sarah`, `spk_2 → Speaker 2` |
| Rematch again | `matched: 0, considered: 1` — Sarah is now protected, so only one speaker remains eligible |
| Switch learning off | `profiles=0  voiceprints=0` |
| Correct a line's speaker in B | B's voiceprints dropped; profiles untouched; nothing learned |
| Erase B's recording, then rematch | `unavailable: "…because its recording has been deleted."` — erasure removed the audio *and* the voiceprints, so nothing was compared |

Note the third row from the bottom: David stayed *Speaker 2*, because nobody
ever named him. That is the feature declining to guess, which is the half that
is easy to get wrong and hard to notice.

The segments were seeded directly into Postgres for this run — the dev
environment has no AssemblyAI key, so transcription is the mock and would not
produce diarization matching the real audio. Everything downstream of the
segments is real.

Neither audio file is committed (`benchmark-audio/` is gitignored) and neither
is needed to run the test suite: the regression tests construct vectors
directly.

## 9. Known limitations

- **A meeting processed before consent was given has no cached voiceprints.**
  They are computed on demand from the recording, so rematch still works — until
  the recording is erased, after which that meeting can no longer be rematched.
  Correct, and worth knowing.

  Rematch says so rather than shrugging. With no recording *and* no cached
  voiceprint there is nothing to compare, so the answer is
  `unavailable: "Speaker matching is unavailable for this meeting because its
  recording has been deleted."` — not `matched: 0`, which is a claim that the
  voices were listened to and recognised as nobody. The two are different facts
  and used to produce the same sentence.

- **Correcting who said a line throws that meeting's voiceprints away.** A
  voiceprint is an average of the spans one speaker key owned when it was
  computed; moving a span between keys is exactly the statement that the average
  was built from the wrong audio. They are dropped rather than recomputed, so
  the next rematch on that meeting re-embeds from the recording and is slower.
  Renaming a speaker does not do this — naming says *whose* a voice is and moves
  no spans, so the cache stays true and is what the account's profile is learned
  from.
- **Enrolment quality depends on the meeting you happened to name somebody in.**
  A profile built from one short turn will match poorly. The sample count is
  shown in Settings for exactly this reason: it is the only thing that makes
  "why did it not match?" actionable.
- **Two people who genuinely sound alike will simply never resolve.** By design.
  The margin check will refuse both of them for ever, and the manual rename is
  the answer.
- **The 1.91 GB image.** Stated here rather than discovered at deploy time.
- **A reprocess resets every name in that meeting.** The transcript is rebuilt
  from the audio, so the labels go back to *Speaker N*. The profiles survive —
  they belong to the account — so one press of Rematch puts the names back,
  which is the main reason reprocessing is a reasonable thing to offer at all.
  The meeting's cached voiceprints are deliberately dropped at the same time:
  they are filed under meeting-local speaker keys, a reprocess re-derives those
  keys by first appearance, and a stale entry would hand the previous occupant's
  voice to whoever inherits the key.
