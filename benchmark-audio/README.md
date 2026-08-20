# Benchmark audio

**Nothing in this directory is committed.** `.gitignore` excludes it, apart from
this file.

Two reasons, and both matter:

1. The recordings used for benchmarking are third-party material we do not own.
2. Reference transcripts derive from those recordings, so they carry the same
   restriction — and a meeting transcript in a public repository is a leak
   whether or not anybody meant it as one.

Drop your own files here:

```
transcription-test.mp3     the audio
otter-reference.txt        a human or reference transcript of that same audio
```

Then see [docs/transcription-benchmark.md](../docs/transcription-benchmark.md)
for how to run the comparison and — more importantly — how to make it a fair
one.
