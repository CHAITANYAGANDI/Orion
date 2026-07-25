# Recallix AI — Demo Script (for the portfolio video)

Target length: 2–3 minutes.

1. **Landing page** (0:00) — read the one-line pitch, scroll the "how it works".
2. **Sign in** (0:15) — Clerk sign-in (or dev mode). Land on the dashboard.
3. **Dashboard** (0:25) — point out recent meetings, open action items, usage meter.
4. **Upload** (0:35) — drag an audio file, add title + participants + tags, submit.
   Note the presigned S3 upload (Network tab shows PUT straight to storage).
5. **Live processing** (0:55) — WebSocket timeline: UPLOADED → TRANSCRIBING →
   SUMMARIZING → EXTRACTING → READY, with progress %.
6. **Meeting detail** (1:20) — summary + key points, transcript, decisions,
   action items with owner/due/priority, risks, source snippets.
7. **Action items** (1:45) — edit owner/due/priority, mark one done; show it on
   the cross-meeting Action Items page.
8. **Search & export** (2:05) — search a past decision; export the brief as PDF/Markdown.
9. **Billing** (2:20) — show plan cards + usage limits; (test-mode) Stripe checkout.
10. **Phase 2 teaser** (2:35) — open the Agent panel, generate a draft action plan,
    show the approval screen (execution stubbed).

Sample audio: use any short meeting recording, or run with `AI_PROVIDER=mock`
for a deterministic scripted brief that always demos cleanly.
