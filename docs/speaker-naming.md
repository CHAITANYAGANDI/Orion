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

| | [Rematch speakers](./speaker-identification.md) | Speaker naming *(this)* |
|---|---|---|
| Asks | Whose **voice** is this? | Did the **conversation** say who these people are? |
| Evidence | An ECAPA-TDNN embedding of the audio | The words, and only the words |
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
disagreeing with itself. This is the *margin* rule from `app/voiceprints.py`,
and it is here for the same reason: when the best answer is not distinctly the
best, the honest answer is none.

One name landing on **two** speakers refuses both, with no margin and no winner.
That collision is what a mention looks like from the inside, and unlike the
nickname case the two candidates are not two descriptions of one person — they
are two people, one of whom is about to be given the other's name.

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
