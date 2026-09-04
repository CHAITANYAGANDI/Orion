# Reading a speaker's name out of the conversation

A meeting opens:

```
Speaker 1:  Hi, how are you Michael?
Speaker 2:  I'm good, Charles.
```

Every human reading that knows who is who. Reverie printed **Speaker 1** and
**Speaker 2** over the top of it, and the fix for that used to be typing two
names by hand.

Now the pipeline reads it. This is what the feature is allowed to conclude, and
the longer half — what it is not.

---

## 1. This is not the voice-matching feature

Two different questions, and confusing them is how the wrong person ends up
named.

| | [Rematch speakers](./speaker-identification.md) *(removed)* | Speaker naming *(this)* |
|---|---|---|
| Asks | Whose **voice** is this? | Did the **conversation** say who these people are? |
| Evidence | An ECAPA-TDNN embedding of the audio | The words, and only the words |
| Status | **Removed.** The model and the stored templates are gone — see the linked page | Live |
| Scope | Across every meeting the account has | This meeting, and no other |
| Stores | A voice template, with consent | Nothing |
| Runs | When the user presses the button | Automatically, once, after transcription |
| Needs consent | **Yes** — biometric-adjacent data | No — it stores nothing and derives nothing from anybody's body |

§2 of that document rules out reading the transcript, and that ruling stands
unchanged: the words cannot tell you that a voice here is a voice there. This
feature never tries. A name found in a meeting is applied to that meeting and
goes no further — it is never written to a profile, never compared against one,
and never carried to another recording.

## 2. The direction, which is the whole difficulty

**A name spoken in a turn almost never belongs to the person saying it.**

```
Speaker 1:  Hi, how are you Michael?      <-  Michael is SPEAKER 2
Speaker 2:  I'm good, Charles.            <-  Charles is SPEAKER 1
```

This reads as pedantry until you look at what getting it wrong costs. It does
not produce one wrong label — it swaps two people across the entire transcript,
and then the summary is written from that, the retrieval passages are indexed
from it, the export carries it, and chat reads it back out as *"Michael said we
would ship on Friday"* with a citation underneath. Nothing distinguishes that
from a true answer.

So there are exactly two kinds of evidence, and which one was seen is a
**required field on every claim** rather than something inferred afterwards:

- **`introduced`** — they said their own name. *"I'm Michael"*, *"Michael
  here"*, *"my name is Michael"*. Names the person **talking**.
- **`addressed`** — somebody said their name **to** them. *"how are you,
  Michael?"*, *"thanks, Michael"*, *"Michael, can you take this?"*. Names the
  person being **spoken to**, never the speaker.

A claim whose direction contradicts who actually holds the turn is **dropped,
not flipped**. A model that got the one field it cannot recover from the text
wrong was not reading carefully, and the rest of what it said is not evidence.

## 3. The model proposes; the transcript decides

Same shape as [`app/quotes.py`](../ai-service/app/quotes.py), for the same
reason: a model asked who these people are will answer, fluently, whether or not
the transcript says so.

So it is not asked for an answer. It is asked for **claims** — each carrying a
turn number and a verbatim quote — and [`app/naming.py`](../ai-service/app/naming.py)
checks every one against the segments before a single label moves. The checks
are arithmetic on the transcript, not opinions about the answer:

1. **The quote is really in that turn.** Normalised for the punctuation models
   rewrite freely, never fuzzy — a paraphrase has to fail or the check is
   theatre.
2. **The name is really in the quote**, matched on whole words. "Ann" is inside
   "announcement"; "Michael" is inside "Michael's", and that apostrophe is the
   difference between being addressed and being discussed.
3. **The direction matches who spoke** (§2).
4. **The named speaker is actually nearby.** You are addressed by somebody in
   the conversation with you, so an `addressed` claim requires the named speaker
   to hold a turn within two *runs* of the evidence. Runs, not turns: one person
   speaking in five segments is one run, and counting segments would put the
   person they just greeted "five away" for no reason a reader would recognise.
   In a two-person meeting the check is satisfied by construction, which is
   correct — with two voices, "not the one talking" is the other one.
5. **The name is name-shaped**, and is not one of the forms of address that sit
   in exactly the same grammatical slot. Without this the product ships
   transcripts spoken by somebody called **Mate**, **Everyone** or **Sir**.
6. **Nobody is renamed to a name somebody else in the meeting already has.**

### A mention is not an address

The commonest way somebody who was not in the room gets a seat at the table:

```
"Michael said he'd handle it"          -> a mention. Michael may be on holiday.
"Let's use Michael's numbers"          -> a mention.
"Chaitanya will finish it by Friday"   -> a mention. This is how work is assigned.
"Michael, will you take this?"         -> an address. Same modal, opposite job.
```

The prompt forbids reporting these. The prompt is not what stops them: a name
followed by a reporting verb, a third-person pronoun or a possessive is the
grammatical subject of its sentence and is refused structurally. Modals are
settled by the word after them — a second-person pronoun means the sentence
turned to face somebody.

### Ties refuse

Two different names for one speaker resolve by weight of evidence and refuse
outright when the support is equal. Five turns calling somebody Michael and one
calling them Mike is a nickname, not a contradiction; one each is the transcript
disagreeing with itself. It is the same *margin* rule the removed voice matcher
used, and it is here for the same reason: when the best answer is not distinctly
the best, the honest answer is none.

One name landing on **two** speakers refuses both, with no margin and no winner.
That collision is what a mention looks like from the inside, and unlike the
nickname case the two candidates are not two descriptions of one person — they
are two people, one of whom is about to be given the other's name.

## 3a. Precedence: a person's answer always wins

One rule, in [`naming.display_name`](../ai-service/app/naming.py), read top to
bottom:

```
display =  a name a person gave this speaker      (a rename, or a rematch)
        ?? a name the conversation gave them      (this feature)
        ?? the label diarization produced         ("Speaker 2")
```

Inference occupies the **middle** tier and can only ever fill an empty one. A
name somebody typed and a name an acoustic rematch resolved are both "not a
placeholder", so both win the first branch and nothing below is consulted. That
is what makes *manual beats inferred* true by construction rather than by
ordering the callers correctly — there is no path that reaches the second line
while the first has an answer.

It is a function and not a guard on purpose. It used to be a negated condition
inside `apply` — *don't write unless the label is unresolved* — which is the
same rule read backwards, and a rule that can only be read backwards is one the
next caller re-implements slightly differently.

`status == "unknown"` short-circuits above both, and is checked first because
*"Unknown speaker"* looks like a placeholder and is not one: the provider
declined to say whose the turn was, so naming it would invent the single fact
the provider refused to supply.

## 3b. What the realtime provider actually sends

Checked against AssemblyAI's published streaming spec rather than assumed,
because "live text stopped identifying speakers" has two causes with one
symptom, and only one of them is Reverie's.

**The realtime provider does supply speaker ids.** `speaker_labels=true` on
`wss://streaming.assemblyai.com/v3/ws` puts a `speaker_label` on **every** Turn
event, partial and final alike. Word-level `speaker` is **only present on final
words** (`word_is_final: true`). The default model when `speech_model` is
omitted is `universal-3-5-pro`, which is why this app deliberately does not pin
one.

```jsonc
// realtime, before Reverie transforms it
{ "type": "Turn", "turn_order": 0, "turn_is_formatted": true, "end_of_turn": true,
  "transcript": "Hello world.", "speaker_label": "A",
  "words": [ { "text": "Hello", "start": 0, "end": 500, "speaker": "A" } ] }

{ "type": "SpeakerRevision",
  "revisions": [ { "turn_order": 3, "speaker_label": "B",
                   "words": [ { "text": "Hello", "speaker": "B", "start": 1200 } ] } ] }
```

```jsonc
// offline, before Reverie transforms it — a different API and a different shape
{ "utterances": [
    { "speaker": "A", "text": "Hi Michael, how are you?", "start": 0, "end": 2100,
      "confidence": 0.98,
      "words": [ { "text": "Hi", "start": 0, "end": 300, "speaker": "A" } ] } ] }
```

The partial case is the one that matters: a partial carries `speaker_label` but
its words carry no `speaker`, so `linesFor` takes the turn's own label as the
fallback for every word. That is why a partial is attributed at all, and it is
worth knowing the two do not degrade together — **offline diarization working is
not evidence that realtime diarization is working**, and vice versa. They are
different endpoints with different models and different message shapes.

To settle it in a live deployment rather than by reading this, turn on the raw
trace in the recording tab's console:

```js
localStorage.setItem("reverie:live-trace", "1")   // then record; off with removeItem
```

It prints every `Begin`, `Turn` and `SpeakerRevision` exactly as the provider
sent it. A `Turn` with no `speaker_label` is the provider declining; a `Turn`
carrying one that renders as *Unknown speaker* is Reverie's bug.

## 3c. Settling it on a real recording

Two traces, one on each path, because **offline diarization working is not
evidence that realtime diarization is working** and vice versa — different
endpoints, different models, different message shapes.

Record 1–2 minutes with two clearly different voices alternating several times.

**Live** — in the recording tab's console, before pressing record:

```js
localStorage.setItem("reverie:live-trace", "1")   // speaker metadata only, no text
localStorage.setItem("reverie:live-trace", "full") // whole message, if a shape is unclear
localStorage.removeItem("reverie:live-trace")      // off
```

```
[reverie:live] Turn turn_order=0 end_of_turn=true formatted=true speaker_label="A" words=["A" x11]
[reverie:live] Turn turn_order=1 end_of_turn=true formatted=true speaker_label="B" words=["B" x7]
[reverie:live] SpeakerRevision turn=0 -> "B" words=["B" x11]
```

**Offline** — set `DIARIZATION_TRACE=true` on the ai-service and reprocess:

```
diarization utterance 0 A 0.0 4.12
diarization utterance 1 B 4.31 9.04
```

Neither prints a word of transcript. The existing INFO line already gives the
summary without any flag at all:

```
AssemblyAI returned 87 segment(s) across 1 speaker(s) ... Provider labels ['A']
```

### Reading the result

| | realtime provider | rendered live | verdict |
|---|---|---|---|
| **A** | `A,B,A,B` | one speaker | **Reverie live bug** |
| **B** | `A,A,A,A` | one speaker | provider or capture |

| | offline provider | processed result | verdict |
|---|---|---|---|
| **C** | `A,B,A,B` | one speaker | **Reverie pipeline bug** |
| **D** | `A,A,A,A` | one speaker | provider or capture |

A and C are the ones that would mean the code is still wrong despite everything
in §8, and neither has been ruled out by observation — only by construction.

**SpeakerRevision is applied, not logged.** `applySpeakerRevision` rewrites the
buffered turn's `speaker`, `speakerKey`, `speakerRaw` and `speakerStatus` in
place, including on a turn that has already finalised and is on screen. Proven in
`live-speaker-ownership.test.ts`: an A→B revision relabels the settled line and
reuses the canonical identity already assigned to B rather than inventing a
third number; `PENDING`→`A` resolves an unattributed line; a revision whose
words disagree splits the turn into `A, B, A`; a revision to `PENDING` after a
real answer is ignored; and a revision carrying a turn order from a previous
session is dropped rather than relabelling the wrong line.

## 4. What it will never do

- **Never overwrite a name a person typed.** Only labels Reverie itself
  generates — `Speaker 1`, `spk_2`, `Unknown speaker` — are candidates, tested
  by the same `is_unresolved` that guards acoustic matching, and re-tested at
  the moment of writing. There is one definition of "still a placeholder" in the
  service rather than two that can drift.
- **Never touch an unattributed turn.** The provider declined to say whose it
  was, so the words under it may be anybody's. There is nothing there to name.
- **Never guess from context.** Not from the topic, the project, the company,
  the meeting title, the account holder's own name, or who usually attends a
  meeting like this. This is structural rather than instructed: the only things
  the pass is given are the numbered turns and the list of placeholder labels.
  It has no access to the account, the title or anything else, so there is
  nothing to guess from.
- **Never learn anything.** A name found here does not create or update a voice
  profile. Enrolment still happens in exactly one place — a human renaming a
  speaker — and the asymmetry that protects (identification must never feed
  itself) is untouched.
- **Never fail a meeting.** A model that is down, slow or malformed returns
  nothing, and nothing is what a transcript that names nobody returns too. The
  meeting arrives with Speaker 1 and Speaker 2 in it and leaves the same way.

## 5. Where it runs, and why there

Last thing in the transcription stage, after diarization and refinement have
settled who spoke, and **before** analysis begins.

```
transcribe -> refine boundaries -> annotate languages -> READ NAMES -> index + summarize
```

Before analysis, because everything downstream carries the speaker prefix. The
flat transcript the summarizer reads, the passages chat retrieves, the verified
quotations, the export. Naming afterwards would produce a brief that says
*Speaker 2* beside a transcript that says Michael, and would need a re-index to
repair — which is precisely the desynchronisation that `renameSpeakers` and
`rematchSpeakers` each have a tail of cleanup code to avoid.

It costs one model call per recording. Nothing in Spring changed: the names
arrive on the segments through the existing callback, in the field that already
carried `Speaker 1`.

A **reprocess** re-derives them, like everything else about the transcript. A
name a user typed is not in danger from that — reprocessing already resets every
label in the meeting, which is documented and is why one press of Rematch is the
intended follow-up.

## 6. The switch

`SPEAKER_NAMING_ENABLED`, default **on**. Off means the extra call is not made
and every speaker stays a number.

Deliberately separate from the voice-template consent flag, which is off by
default and must stay that way. They are not the same kind of thing: one stores
a stable identifier derived from a person's body and needs consent before it
computes anything at all, and this one reads words the meeting already said, for
the meeting they were said in, and keeps nothing.

## 7. Known limitations

- **Most meetings say nobody's name.** Returning nothing is the common case and
  the correct one. Rematch remains the answer for a meeting whose speakers are
  known to the account but never named out loud.
- **Three or more speakers are harder, and quietly so.** The adjacency check is
  what makes an `addressed` claim safe, and it is far stronger with two voices
  than with six — *"Michael, what do you think?"* in a large meeting is only
  evidence about whoever answers. Expect fewer names from a big meeting, which
  is the right way for it to degrade.
- **A name said only once, in passing, will often not survive the checks.** That
  is the intended trade: the alternative is a name on the page that nothing can
  be traced back to.
- **The mock provider finds far less than a real model.** Three patterns —
  self-introductions, greetings, trailing vocatives — so the dev environment can
  demonstrate the feature without a provider key. It generates claims like any
  other adapter and they go through the identical verification, so what a
  developer sees locally is the checks working, not a shortcut around them.
- **Nothing tells the user a name came from the dialogue rather than from a
  person.** It looks in the transcript exactly like a name somebody typed. That
  is a real gap and is stated here rather than discovered: the honest version
  would carry the provenance through to the UI, and the reason it does not yet
  is that no column records it.

## 8. It is an overlay, and here is the proof

A four-minute two-person recording was reported rendering as **Speaker 1
(100%)** shortly after this feature shipped, and the natural reading was that
naming had merged the speakers. It had not, and the reasoning is worth keeping
because the same suspicion will arise again.

**Three identities travel with every segment and only one of them is mutable:**

### The five speaker repairs, and which question each answers

They are easy to confuse, and picking the wrong one is how a transcript ends up
worse than it started.

| You noticed | Use | What changes |
|---|---|---|
| This speaker's **name** is wrong | **Rename** | The display name, everywhere that speaker appears. The key does not move, so colour and talk time stay attached. |
| These words were **another person already here** | **Change speaker** | Who owns that turn, or a word range of it. Nobody else is touched. |
| These words were **somebody not in the list** | **New speaker** | A new canonical identity for this meeting (`spk_`highest+1, `Speaker N`), and the turn moves to it. |
| These **two speakers are one person** | **Merge** | Every turn of one takes the other's identity; the folded label stops existing. |
| The notes now disagree with the transcript | **Re-summarize** | Regenerates the notes from the corrected transcript and current speakers. Never automatic. |
| The diarization is wrong throughout | **Reprocess** | Re-transcribes and re-diarizes the original audio. **Destructive** — it can replace manual speaker corrections. |

None of these reaches another recording. `speaker_raw` is untouched by all of
them: it records what the provider said, and a human correcting Reverie's
reading of that is not a correction to the record of it.

| Field | Example | Written by |
|---|---|---|
| `speaker_raw` | `"A"` | the provider, once. Never displayed, never rewritten. |
| `speaker_key` | `"spk_1"` | the canonical mapper, once. Owns colour and talk-time. |
| `speaker` | `"Speaker 1"` | a rename or this feature. Display only. |

`naming.apply` assigns `speaker` and touches nothing else. It cannot merge two
speakers because a name claimed for two of them is refused outright (§3), and it
cannot renumber anybody because it never writes `speaker_key`.

The chain was checked end to end and every link preserves ownership:

```
AssemblyAI utterances   A, B, A, B
  parse_response        spk_1, spk_2, spk_1, spk_2   raw A, B, A, B
  naming.apply          Charles, Michael, Charles, Michael   raw + keys UNCHANGED
  Spring replaceSegments  persists speaker, speaker_key, speaker_raw separately
  groupIntoTurns        merges on speakerKey, never on the displayed name
  SpeakerStatsDto       two keys, two rows, 75% / 25%
```

`tests/test_naming_is_an_overlay.py` runs exactly that, from a realistic
provider payload through the real pipeline, and asserts the raw tuple survives
naming, model failure, malformed claims, a collision and a pre-existing manual
name.

**So a transcript that shows one speaker has one speaker in the provider's
response.** The next place to look is the recording, not the code — and the line
that settles it is already logged at INFO by the ai-service:

```
AssemblyAI returned 87 segment(s) across 1 speaker(s), language=en.
Provider labels ['A'] mapped to canonical speakers in order of first appearance.
```

`across 1 speaker(s)` with `['A']` is the provider clustering the whole room as
one voice. Reverie has nothing to recover from that: the acoustic repair that
used to run here (`app/rediarize.py`, since deleted) could move words *between
speakers the provider already found* and deliberately could not invent a second
one, so even then a single label left it nothing to do. Today there is no
acoustic stage at all and the provider's clustering is final.

### An untested hypothesis, labelled as one

Everything above this line is proven. What follows is **not**, and is recorded
as a lead rather than as an answer: no failing recording has yet been traced end
to end, so the sentence "the provider returned one speaker" is a deduction from
the code being correct, not an observation of the provider's output.

The two are not the same claim. Proven: `A,B,A,B` in gives `A,B,A,B` out. Not
proven: that the failing recording was ever `A,A,A,A`. Until a real reproduction
shows the provider's own labels, the honest position is that the collapse
happens *before* `parse_response` and the reason is unknown.

See §3c for what a reproduction has to capture to settle it.

### Why a hybrid call *might* collapse — a lead, not a conclusion

`use-recorder.ts` captures the **microphone only** — "the microphone is the
whole recording" — with echo cancellation off so that people in the room and
coming out of the laptop are both audible.

That is right for a room and is the hard case for diarization. Everyone dialling
in is reproduced by *one loudspeaker* and re-recorded by *one microphone*, so
the acoustic differences a speaker embedding relies on are flattened into the
same channel, the same room and the same speaker cone. Clustering them as one
voice is a defensible answer to the audio that arrived.

This is not a claim that it always happens, and it is not a defect in the
clustering. It is the reason a transcript can be plainly multi-party to a reader
and single-speaker to a model, and the reason **Rematch speakers** and manual
renaming both still exist.
