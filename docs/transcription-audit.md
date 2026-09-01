# Transcription audit — before

Written before any code changed, from reading the path end to end. Every claim
about the AssemblyAI API below was checked against the live API rather than
against the documentation; where the two disagreed, the live API won and the
disagreement is recorded.

> Section 4 below ("Where speaker labels originate") describes the speaker
> handling as it stood at the time and is superseded by
> [diarization.md](diarization.md), which covers the two bugs that description
> was hiding: word-level attribution being discarded, and provider cluster
> letters being decoded as speaker numbers.

## 1. Where audio travels

```
                  ┌───────────────────────────────────────────┐
   microphone ───▶│ getUserMedia (use-recorder.ts)            │
                  │   AudioContext                            │
                  │     micSource ─┬─▶ MediaStreamDestination │──▶ MediaRecorder
                  │                └─▶ AnalyserNode (meter)   │      (webm/opus)
                  └───────────────────────────────────────────┘
                                                                       │
                                        ┌──────────────────────────────┘
                                        ▼
                        presigned PUT ──▶ Cloudflare R2 (private)
                                        │
                        Spring createMeeting ──▶ outbox ──▶ Kafka meeting_uploaded
                                        │
                                        ▼
                        ai-service kafka_worker
                                        │  storage.fetch_audio  (downloads WHOLE file)
                                        ▼
                        AssemblyAiTranscriptionAdapter
                                        │  POST /v2/upload      (uploads WHOLE file again)
                                        │  POST /v2/transcript
                                        │  GET  /v2/transcript/{id}  (poll)
                                        ▼
                        parse_response ──▶ Segment[] ──▶ Spring callback ──▶ Postgres
```

A **second, entirely separate** audio path existed for the live preview:

```
   microphone ───▶ window.SpeechRecognition ───▶ Google / Apple ───▶ interim strings
```

Note that this is a *different `getUserMedia` call*. It is not the recorder's
stream and does not honour the microphone chosen in the control bar.

## 2. Current live transcription architecture

`frontend/lib/use-live-transcript.ts`, consumed by `recording-context.tsx` and
drawn by `app/(app)/record/page.tsx`.

* `window.SpeechRecognition` / `webkitSpeechRecognition`.
* Firefox: unsupported, blank pane.
* Chrome streams audio to Google, Safari to Apple.
* Restarted on `onend` because Chrome ends the session on silence.
* Produces `LivePhrase { id, at, text }` — **no speaker**, no word timings, no
  confidence.
* `at` is `elapsed` — Reverie's own `setInterval` second-counter — sampled at
  the moment the **first interim result arrived**, not when the words were
  spoken.

## 3. Current final transcription architecture

`ai-service/app/providers/assemblyai_adapter.py`, driven by
`app/pipeline.py::Pipeline.process` from `app/kafka_worker.py`.

Request body sent today:

```json
{
  "audio_url": "<assemblyai-hosted upload>",
  "speech_models": ["universal-3-5-pro", "universal-2"],
  "speaker_labels": true,
  "punctuate": true,
  "format_text": true,
  "language_code": "…"  |  "language_detection": true,
  "word_boost": ["…"],        // only when the user has vocabulary
  "boost_param": "high"
}
```

Parsing keeps `start`/`end` (ms→s), `speaker`, `text`, per-word timings. It
**discards** `confidence`, which is present on every utterance and every word.

## 4. Where speaker labels originate

Only from the async job — `utterances[].speaker`, letters `A`, `B`, `C`, mapped
by `speaker_label()` to `Speaker 1`, `Speaker 2`. The live preview has no
speaker concept at all, which is why the screenshot shows one undifferentiated
column where Otter shows a speaker change at 0:20.

`speaker_label()` ends with `return "Speaker 1"` for anything it does not
recognise — including `None` and `"UNKNOWN"`. That is a **false attribution**:
an unknown speaker is silently merged into the first one.

## 5. Transcription context available but unused

Reverie already knows all of this at enqueue time and sends none of it:

| Known | Where it lives | Sent today |
|---|---|---|
| Meeting title | `Meeting.title` | ✗ |
| Project/folder name | `Meeting.projectId` → `Project.name` | ✗ |
| Summary template ("Engineering sprint review") | `Meeting.summaryTemplate` | as a slug, for the LLM only |
| Names the user has applied to speakers before | `known_speakers` table | ✗ |
| The user's own display name | `UserEntity.displayName` | ✗ |
| Custom vocabulary | `vocabulary_terms` | as `word_boost` only |
| How many people are expected | *not modelled* | ✗ |

## 6. AssemblyAI facts, verified against the live API

Probed with the deployment's own key; jobs were submitted against a public
sample file and their parameters read back from the job record.

| Claim | Source | Verdict |
|---|---|---|
| `word_boost` is *rejected* by `universal-3-5-pro` | web docs | **False.** HTTP 200, echoed back on the completed job. It is superseded, not refused. |
| `keyterms_prompt` + `prompt` accepted on `universal-3-5-pro` | docs | **True**, both echoed on the completed job. |
| `speaker_options.{min,max}_speakers_expected` | docs | **True**, echoed. |
| `speakers_expected` and `speaker_options` can be combined | — | **False.** `HTTP 400 "Both speaker_options and speakers_expected can not be used in the same request."` |
| Utterances/words carry `confidence` | — | **True.** Utterance keys `[confidence, end, speaker, start, text, words]`; word keys `[confidence, end, speaker, start, text]`. |
| Streaming token endpoint | docs | `GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=N`, header `authorization: <key>`, → `{token, expires_in_seconds}`. `expires_in_seconds` is validated to **1–600** (422 outside). |
| Streaming supports `speaker_labels` | docs disagreed with themselves | **True.** `Begin.configuration` echoes `"speaker_labels": true`. |
| Streaming rejects unknown query params | — | **False**, they are ignored. |
| Streaming default model | — | `universal-3-5-pro`, `mode: balanced`, `api_version: 2025-05-12`. |

A methodological note, because it changed a conclusion: the first pass at the
websocket probe ran six sessions concurrently, hit
`Unauthorized Connection: Too many concurrent sessions`, and I read that as
`speech_model` being an invalid parameter. Re-running one session at a time with
explicit `Terminate` showed every parameter was fine. A concurrency cap and a
parameter rejection look identical at the socket.

## 7. Weaknesses, in the order they cost accuracy

1. **The live path is a different product.** Browser speech recognition, no
   diarization, no word timings, no confidence, and — decisively — *a different
   microphone*. The screenshots are not comparable: one is a room played into a
   laptop mic and recognised by the browser, the other is the source file
   transcribed by a server model.
2. **Live timestamps are invented.** `elapsed` at the moment recognition
   returned, so the 0:04 line is stamped 0:10 in the Reverie screenshot.
3. **Unknown speakers become `Speaker 1`.** False attribution, silently.
4. **No transcription context.** `prompt` and `keyterms_prompt` unused; the
   title, project, template and known speaker names all thrown away.
5. **Vocabulary capped at 100** and sent through the superseded `word_boost`.
   The current ceiling for `keyterms_prompt` on this model is 1000.
6. **Diarization is unconstrained.** No way to say "two people".
7. **The file crosses the network twice** — S3 → ai-service → AssemblyAI — for
   no benefit; the object is already addressable with a presigned GET.
8. **Confidence is parsed and thrown away**, so there is nothing to diagnose a
   bad transcript with.
9. **Failure is silent.** Every exception path returns `_EMPTY`, so a
   misconfigured request produces an empty transcript that looks like a quiet
   meeting.
10. **No objective measurement.** Nothing in the repo can say whether a change
    made transcription better or worse.
