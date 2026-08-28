# Benchmarking transcription

How to find out whether a change to transcription made it better, rather than
deciding it did.

## Why this exists

The natural way to compare two transcripts is to read them side by side. That
method reliably prefers whichever one you read second, and it cannot see the
failure that matters most in a meeting product: words that are right and
attributed to the wrong person.

So: numbers, from the same audio, against a reference.

## Get the files

Nothing in `benchmark-audio/` is committed. The directory is gitignored because
the recordings are third-party material we do not own and the reference
transcripts derive from them.

```
benchmark-audio/
  transcription-test.mp3     # your audio
  otter-reference.txt        # a human or reference transcript of that audio
```

The reference can be an Otter export, a Rev export, or plain
`Speaker 1: words` lines. The format is sniffed, not configured — a flag
somebody sets wrong does not fail loudly, it produces one enormous turn and a
WER of 1.0 that reads as a catastrophic regression.

## Run it

```bash
cd ai-service
set -a && source ../.env && set +a          # ASSEMBLYAI_API_KEY
export TRANSCRIPTION_PROVIDER=assemblyai

python -m benchmark.run ../benchmark-audio/transcription-test.mp3 \
    --reference ../benchmark-audio/otter-reference.txt --json
```

Useful flags, all of which exercise the real request path:

```bash
--speakers-exact 2                 # hard constraint: exactly two voices
--speakers-min 2 --speakers-max 4  # a range, the safer setting
--participant Chaitanya --participant Sarah
--keyterm pgvector --keyterm "Universal-3.5 Pro"
--title "Tuesday design review" --meeting-type "Engineering sprint review"
--language en
--save /tmp/hypothesis.txt         # write the transcript out to read
```

## Make the comparison a fair one

**Do not** compare this:

```
room ──▶ speakers ──▶ laptop microphone ──▶ browser speech recognition
```

against this:

```
source file ──▶ uploaded directly ──▶ another product's async transcription
```

That was the shape of the original complaint about Orion's quality, and it
measures mostly the microphone. Two different signals, two different processing
modes; the gap between them is not the thing anybody wanted to know about.

Run the **same file** through both.

## What the numbers mean

| Metric | Measures | Blind to |
|---|---|---|
| `wer` | Word Error Rate — edits per reference word | who said it |
| `cer` | the same over characters | word boundaries |
| `cpwer` | **concatenated minimum-permutation WER** — words *and* attribution | nothing much; this is the one to quote |
| `speaker_count_correct` | did diarization find the right number of people | which people |
| `timestamp_drift_seconds` | median error between matched turn starts | turns that did not match |
| `realtime_factor` | processing seconds ÷ audio seconds | queueing |

`cpwer` tries every mapping of hypothesis speakers onto reference speakers and
keeps the best, because speaker *labels* are arbitrary — the reference's
"Speaker 1" and the provider's "A" have no reason to be the same person. A
wholesale label swap is therefore **not** an error. Words that cross a speaker
boundary are.

`timestamp_drift_seconds` of `None` means it could not be measured, which is not
the same as zero and must not be averaged with it.

## A worked example, and a warning about references

Run against the sample in this repository's `benchmark-audio/` (36.9s, two
speakers), Universal-3.5 Pro with diarization:

| | auto | `--speakers-exact 2` |
|---|---|---|
| WER | 0.102 | 0.102 |
| cpWER | 0.814 | **0.754** |
| speakers found | 3 | **2** |
| realtime factor | 0.21 | 0.21 |

Two things to read off that table.

**The speaker constraint works.** Unconstrained diarization split one speaker
into two; telling it there were two people fixed the count and took cpWER down
with it. This is the feature working exactly as intended, measured rather than
asserted.

**The cpWER is not a measurement of Orion.** It is high because *this
particular reference does not match this particular audio*: the Otter export
begins mid-sentence — it missed the opening words "This award tonight would
have humbly", which Orion captured — and it contains a turn stamped 0:59 in
a file that is 36.9 seconds long. The median timestamp drift of 6.6s is the
same misalignment showing up a second way.

That is the honest reading, and it is the reason this document exists: a number
from a mismatched reference looks exactly like a number from a bad transcriber.
**Before quoting any of these figures, check that the reference is a transcript
of the file you ran.**

## A benchmark set worth having

One clip is enough to catch a crash and not enough to catch a regression. The
cases below are the ones where transcription quality actually varies, and the
harness takes each of them the same way:

- two-speaker clean meeting *(the base case)*
- three-to-five person meeting *(where diarization starts to cost)*
- accents, and speakers whose first language is not the meeting's
- fast speech and short interjections — "mm hm", "yep", "wait" — which are
  where speaker attribution is least certain
- overlapping speakers
- a noisy room, or a speakerphone at the far end of a table
- heavy technical vocabulary *(run with and without `--keyterm` to see what
  prompting buys)*
- names and acronyms *(the same, with `--participant`)*
- multilingual and code-switching
- one long meeting, for the realtime factor and for whether speaker identity
  holds from the first minute to the fiftieth

Keep them out of git and keep the reference beside each one.

## Running the tests instead

The scorer itself is tested without any audio, key or network:

```bash
cd ai-service && python -m pytest tests/test_benchmark_metrics.py -q
```
