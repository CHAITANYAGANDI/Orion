"""Application configuration via pydantic-settings.

All values are read from environment variables (see docker-compose.yml
`ai-service.environment`). Sensible defaults let the service boot in mock mode
with no external dependencies.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

AiProvider = Literal["mock", "openai"]

# Transcription is chosen separately from the LLM. Whisper cannot diarize, so
# the useful real-world combination is a diarizing vendor for speech and OpenAI
# for analysis — and during development, that vendor for speech with the mock
# LLM, which costs nothing and still exercises the real audio path.
# "auto" follows `ai_provider`, which is what every existing deployment expects.
TranscriptionProvider = Literal["auto", "mock", "openai", "assemblyai"]


class Settings(BaseSettings):
    """Runtime configuration for the ai-service."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- Kafka ---
    kafka_bootstrap_servers: str = "localhost:9092"
    kafka_consumer_group: str = "ai-service"
    kafka_topic_meeting_uploaded: str = "meeting_uploaded"
    # Local Kafka listens without auth. A managed broker needs SASL_SSL plus an
    # API key/secret; the credentials are only applied when the protocol asks
    # for them, so leaving these unset keeps the local path untouched.
    kafka_security_protocol: str = "PLAINTEXT"
    kafka_sasl_mechanism: str = "PLAIN"
    kafka_sasl_username: str | None = None
    kafka_sasl_password: str | None = None
    # How long the consumer may go without taking a message before Kafka decides
    # it has stopped and evicts it. 100 minutes, and not a round number picked
    # for looking generous:
    #
    #   * transcription is the floor. `assemblyai_timeout_seconds` is 900 and
    #     `assemblyai_max_retries` is 2, so one transcription can legitimately
    #     take 3 x 900s plus backoff = ~45 minutes before it gives up.
    #   * fetching the audio costs up to `download_timeout_seconds` twice (60s
    #     each) when the provider cannot reach the object and the bytes have to
    #     be uploaded instead.
    #   * speaker refinement decodes the audio with a 120s ceiling, plus the
    #     embedding calls around it.
    #   * summarize, extract, suggestions and RAG indexing are each bounded by
    #     `openai_timeout_seconds` x (`openai_max_retries` + 1) ~ 190s; the first
    #     two run concurrently.
    #   * the result and status callbacks are 15s apiece.
    #
    # 2703 + 120 + 120 + 540 + 30 = ~3513s, so ~59 minutes of worst case --
    # against a recording that cannot exceed 100 minutes anyway, because that is
    # the whole AI-minute allowance an account ever gets. 100 minutes leaves
    # ~41 minutes of margin over it.
    #
    # Being generous costs nothing here: one worker consumes one partition, so
    # evicting it early buys no failover, it only guarantees the meeting in
    # flight is transcribed twice and paid for twice.
    kafka_max_poll_interval_ms: int = 6_000_000

    # The *other* eviction timer, and the one that actually bit.
    #
    # `max_poll_interval_ms` above bounds how long the consumer may go without
    # taking a message. This bounds how long the broker may go without hearing
    # from it at all, and the two are independent: the heartbeat is its own
    # coroutine on the event loop, so it stops being sent the moment something
    # else refuses to yield. That is what happened -- ECAPA speaker refinement
    # ran synchronously on the loop for nine minutes, the heartbeat coroutine
    # was never scheduled, the broker declared the member dead at ten seconds,
    # the group rebalanced, the hand-committed offset stayed put, and the
    # meeting came back to be transcribed again. Twice, at full price.
    #
    # The real fix is that the blocking work now runs in a thread
    # (`speaker_identity._voiceprints`), so the loop stays
    # free. This is the belt beside it: 45 seconds rather than aiokafka's
    # 10-second default, so a garbage collection, a model load or a burst of
    # GIL contention cannot cost a transcription. It is still far below
    # `max_poll_interval_ms`, so a worker that has genuinely died is still
    # noticed in under a minute rather than in an hour and a half.
    #
    # Brokers reject a session timeout outside `group.min.session.timeout.ms`
    # (6s) .. `group.max.session.timeout.ms` (30 min); 45s is comfortably
    # inside both.
    kafka_session_timeout_ms: int = 45_000
    # Kafka's own guidance is no higher than a third of the session timeout, so
    # three heartbeats have to be missed before eviction rather than one.
    kafka_heartbeat_interval_ms: int = 10_000

    # --- Spring internal callback ---
    spring_callback_url: str = "http://localhost:8080"
    reverie_internal_token: str = "dev-internal-token"

    # --- AI provider selection ---
    ai_provider: AiProvider = "mock"
    transcription_provider: TranscriptionProvider = "auto"

    # --- AssemblyAI (speech-to-text with speaker diarization) ---
    # The whole recording is diarized in one pass, so speaker identity holds
    # across a long meeting instead of restarting per chunk.
    assemblyai_api_key: str | None = None
    assemblyai_model: str = "universal-3-5-pro"
    # `speech_models` is a priority list. If the detected language is not
    # supported by the first model, AssemblyAI routes to this one rather than
    # failing the job; blank disables the fallback.
    assemblyai_fallback_model: str = "universal-2"
    # Blank means auto-detect, which is what a multilingual user wants. Set an
    # ISO code (e.g. "es") when every meeting is in one language — detection is
    # good but not free of mistakes, and a wrong guess corrupts the transcript.
    assemblyai_language: str = ""
    # The API is asynchronous, so this bounds the whole upload/submit/poll
    # cycle rather than one request. Generous: an hour of audio queued behind
    # other jobs should wait, not fail.
    assemblyai_timeout_seconds: float = 900.0
    assemblyai_poll_interval_seconds: float = 3.0
    assemblyai_max_retries: int = 2

    # --- OpenAI ---
    openai_api_key: str | None = None
    openai_transcribe_model: str = "whisper-1"
    # Writes the summary and attributes action items — the two passes needing
    # judgement, and the ones a user reads. `gpt-5.6-sol` is the stronger
    # sibling if the notes still read thin; it costs about 2.5x more.
    openai_chat_model: str = "gpt-5.6-terra"
    # Entity listing: structured JSON against an explicit
    # schema, which the cost-optimized model handles well for roughly a tenth
    # of the price. Point this at `openai_chat_model` to put everything back on
    # one model.
    openai_extraction_model: str = "gpt-5.6-luna"
    openai_embed_model: str = "text-embedding-3-small"
    openai_timeout_seconds: float = 60.0
    openai_max_retries: int = 2
    # Left unset, so the parameter is not sent at all. Extraction wants
    # temperature 0 for repeatable output, but the current models accept only
    # their default and reject an explicit 0 with a 400 — which surfaced as an
    # entirely empty brief. Set a number here only for a model known to allow
    # it.
    openai_temperature: float | None = None
    # How many chat calls may be in flight at once, counted per model. The
    # brief needs five passes over the same transcript, and on a small
    # tokens-per-minute allowance firing them together is refused outright.
    # Four lets the whole fan-out through, which the current models' limits
    # absorb comfortably; lower it if a 429 ever reappears in the logs.
    openai_max_concurrent_calls: int = 4

    # --- RAG / pgvector ---
    # 1536 = OpenAI text-embedding-3-small; the mock embedder matches this dim.
    embed_dim: int = 1536
    # Eight passages of ~1200 chars gives the model roughly 10k characters to
    # answer from. Four passages of 700 gave it under 3k — about half a page,
    # which is why answers used to miss things that were plainly said.
    rag_top_k: int = 8
    # What "Advanced" retrieves from one meeting instead.
    #
    # Three times the width, which is enough to hold an hour of speech whole:
    # at ~1200 chars a passage, twenty-four of them is nearly thirty thousand
    # characters of transcript. The eight above is not "the whole meeting" and
    # never was -- a fifteen-minute recording already chunks to eleven -- so
    # anything long was being answered from a sample without saying so.
    rag_deep_top_k: int = 24
    rag_chunk_chars: int = 1200
    # ~15%. Enough that a sentence cut by a boundary survives whole in the
    # neighbouring passage, without duplicating so much that retrieval returns
    # the same words several times over.
    rag_chunk_overlap_chars: int = 180
    # Workspace-wide chat spans many meetings, so it needs a wider net than the
    # single-meeting chat above.
    rag_workspace_top_k: int = 10
    # What "Advanced" retrieves instead. Two and a half times the width rather
    # than ten: past roughly this the top-k stops adding calls and starts adding
    # more of the same one, and the context window pays for all of it.
    rag_workspace_deep_top_k: int = 25
    # --- relevance filtering (see app/retrieval.py for the measurements) ---
    #
    # Nearest-neighbour search returns k rows whether or not any of them are
    # about the question. These bound what counts as evidence.
    #
    # The ceiling is measured, not chosen. Against a real indexed workspace on
    # text-embedding-3-small, questions the archive answers bottom out at
    # 0.59-0.61 cosine distance and questions about material that is simply
    # absent start at 0.87. 0.80 sits in that empty band with room on both
    # sides. Anything below ~0.59 returns nothing for every question ever
    # asked, which is the failure mode of picking this number by intuition.
    rag_max_distance: float = 0.80
    # How much worse than the best match a passage may be and still be evidence.
    # Absolute distance says whether anything is relevant at all; this says
    # which survivors are in the same league as the leader. On the benchmark
    # question the strongest meeting spans 0.613-0.680 and the next meeting
    # appears at 0.711, so this keeps the leader whole and trims the echo.
    rag_relevance_margin: float = 0.12
    # Never cut below this many, when this many cleared the ceiling. A broad
    # question ("what did we talk about?") has a long shallow gradient and no
    # leader, and trimming that to one passage answers a wide question from a
    # sliver.
    rag_min_passages: int = 3
    # How many candidates to pull before filtering, as a multiple of what will
    # be kept. Filtering can only discard, so a scan that returns exactly the
    # final budget arrives with nothing to spare and any drop leaves the answer
    # short.
    rag_candidate_multiplier: int = 3
    # Weight of exact word overlap against vector similarity when reranking.
    # Small on purpose: the vector is the ranking and this breaks its ties.
    # Larger, and passages that merely repeat the question's words outrank
    # passages that answer it.
    rag_lexical_weight: float = 0.25
    # Token overlap at which two passages are the same passage. Chunks overlap
    # by design, so consecutive ones genuinely share text.
    rag_duplicate_similarity: float = 0.8
    # Most passages one meeting may contribute to a workspace answer. Without
    # it the meeting with the most chunks takes every slot -- not for being the
    # best answer, for being the longest.
    rag_max_passages_per_meeting: int = 3
    # And what Advanced allows instead, because a comparison or a timeline is a
    # claim about several meetings and needs more than three lines of each.
    rag_deep_max_passages_per_meeting: int = 6
    # How much a passage's score rises for naming the person or the meeting the
    # question named. Enough to reorder near-equals, never enough to promote
    # something the relevance filter would have dropped.
    rag_name_boost: float = 0.15
    # The user's own earlier questions carried into the prompt so "which of
    # those?" resolves. Their questions only -- never previous answers.
    rag_history_turns: int = 4

    rag_search_limit: int = 20
    # Semantic search dedupes to one hit per meeting after the ANN scan, and the
    # owner filter discards some candidates, so the inner scan fetches this
    # multiple of the requested limit to avoid under-filling the result.
    rag_search_overfetch: int = 8

    # --- Meeting Memory (commitment ledger) ---
    # Passages of the new meeting shown to the LLM when judging one commitment.
    memory_evidence_k: int = 4
    pg_host: str | None = None
    pg_port: int = 5432
    pg_database: str = "reverie"
    pg_user: str = "reverie"
    pg_password: str = "reverie"
    # "prefer" encrypts when the server offers it and falls back when it does
    # not, which is what the local container needs. A managed Postgres (Neon)
    # refuses unencrypted connections outright and wants "require".
    pg_sslmode: str = "prefer"

    # --- S3 / MinIO ---
    s3_endpoint: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_bucket: str = "reverie"
    # Where AssemblyAI should fetch a recording from, when it fetches one
    # itself. Distinct from `s3_endpoint`, which is reachable from inside the
    # compose network and from nowhere else: a presigned URL signed against
    # `http://minio:9000` is valid and unreachable, which is the most confusing
    # possible failure. Blank disables direct fetch and keeps the byte path.
    s3_public_endpoint: str = ""
    s3_region: str = "us-east-1"

    # --- HTTP download ---
    download_timeout_seconds: float = 60.0

    # --- MP3 export ---
    # How long one ffmpeg encode may take. Generous on purpose: LAME runs at
    # tens of times real time, so a two-hour meeting is a couple of minutes, and
    # a limit that cut off the longest recordings would fail exactly the exports
    # that took the most work to reach. The caller is polling, so a slow
    # conversion costs nobody a held connection.
    transcode_timeout_seconds: float = 900.0
    # A ceiling on what will be pulled onto local disk to convert. Nothing Reverie
    # records approaches it; it exists so that a pathological upload is refused
    # with a sentence rather than by filling the container's filesystem and
    # taking transcription down with it.
    transcode_max_bytes: int = 2 * 1024 * 1024 * 1024

    # Log the provider's own diarization, one line per utterance, as
    # `index speaker start end` -- and no transcript text at all, which is what
    # makes it safe to switch on in a deployment holding other people's
    # meetings. Off by default because it is one line per utterance.
    #
    # It exists for one question: a transcript that comes out with a single
    # speaker either arrived that way from the provider or lost the rest here,
    # and those have opposite fixes. The summary line above it ("across N
    # speaker(s)") answers that; this shows the sequence.
    diarization_trace: bool = False

    # --- Speaker naming (reading names out of the dialogue) ---
    # Whether a finished meeting may take speakers' names from what was said in
    # it: "hi, how are you Michael?" makes the *other* speaker Michael. Costs one
    # extra model call per recording, and pays for itself in the summary, the
    # retrieval passages and the export, all of which carry the speaker prefix.
    #
    # Nothing to do with the voice templates below, and deliberately a separate
    # switch: this one needs no consent because it stores nothing and derives
    # nothing from anybody's body -- it reads words the meeting already said,
    # for the meeting they were said in, and never carries a name to another
    # recording. See app/naming.py and docs/speaker-identification.md section 2.
    speaker_naming_enabled: bool = True


    # NOTE: there is no second-opinion diarizer setting any more. The only
    # implementation was pyannote Community-1, and it was removed after being
    # measured rather than after being forgotten: on ground-truth audio it was
    # exact, but so was AssemblyAI, and on the recording the work was
    # commissioned for it reported silence across 14.1 seconds the provider
    # transcribed as 62 words. docs/diarization.md section 12 keeps the numbers.
    # Speaker segmentation is now the transcription provider's, unrefined.
    # A local ECAPA pass over every meeting was tried and removed: it cost
    # torch, speechbrain and a model load in every image, and the production
    # runs it was built for still mis-attributed the turns it was meant to
    # fix.


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance."""
    return Settings()
