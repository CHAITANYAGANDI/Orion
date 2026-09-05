# V2 — final parity audit

Written against the finished branch, not against the plan. Everything below was
checked in the code as it now stands.

- **Branch** `feat/reverie-v2-ui`
- **Baseline** `58a00d0^` — the app as it was before the redesign began
- **Backend** `backend-spring/` and `ai-service/` — **zero files changed**

---

## 1 · Route mapping

| Old | New | Fate |
|---|---|---|
| `/home` — Home | **Now** | Same route. Visual + IA rename, and a **scope change**: see §7. |
| `/folders` — folder list | **Library** | The folder list is a section of `/library`. `/folders` is a **redirect**, kept because that URL is bookmarks, a link on the meeting menu, and where a folder deletion used to land a tab that has not reloaded. |
| — | `/library` | **New route.** Client-only, no new endpoint. |
| `/folder/[id]` | unchanged | Kept. Nested under Library in the band. |
| `/ask` | **Ask** | Unchanged route. Third place in the band. |
| `/meetings/[id]` | unchanged | Kept. Nested under Library. |
| `/record` | unchanged | Kept. |
| `/upload` | unchanged | Kept — the fuller import form, for filing straight into a folder and for direct links. The band's Import is a dialog. |
| `/settings/[[...tab]]` | unchanged | Kept, catch-all. |
| `/privacy`, `/billing` | unchanged | Kept as legacy redirects into `/settings` via `LEGACY_PATHS`. Notifications written months ago still carry them. |
| `/welcome`, auth routes | unchanged | Kept. |

**Visual/IA renames only:** Home→Now, Folders→Library, Upload→Import (the label;
`/upload` survives).
**For compatibility:** `/folders`, `/privacy`, `/billing`.

---

## 2 · Feature mapping

Nothing is listed as preserved on the strength of a component still existing —
each was checked as reachable from the UI.

### Navigation and shell

| Capability | V2 location | Verdict |
|---|---|---|
| Home / AI Chat rail links | Now / Ask, in the band | **RELOCATED** |
| Folder tree in the rail | Library's folder table | **RELOCATED** |
| Notification bell | band, right group | **RELOCATED** |
| Plan / allowance meter | inside the account menu | **RELOCATED** |
| Account menu | band, far right | **RELOCATED** |
| Global search button | band | **PRESERVED** |
| ⌘K / Ctrl-K | shell, window listener | **PRESERVED** |
| Import, Record | band (Record also a bottom tab) | **PRESERVED** |
| Mobile drawer | bottom tabs (Now/Library/Ask/Record) | **SUPERSEDED PRESENTATION** |
| Side pane + its toggle | shell; toggle in the page-action row | **PRESERVED** |
| Rail/pane drag-resize | — | **INTENTIONALLY REMOVED** (§7) |
| `HEADER_SLOT` / `SIDE_PANE` portals | shell | **PRESERVED** |
| Recording survives navigation | provider above the router | **PRESERVED** |

### Now

Greeting and date, recent conversations grouped by day, processing rows with
stage and percentage, failed rows, date window (sticky per sign-in), the chat and
action-items pane, and every empty/error state that can still occur — all
**PRESERVED**. The scope picker is **RELOCATED** to Library and its `unfiled`
parameter **INTENTIONALLY REMOVED** (§7).

### Library, folders

Folder list with sort, star, rename, delete, per-row menus and counts;
all-conversations list; date window. **PRESERVED**, relocated into `/library`.
`FolderTable` gained the three-state handling the rail's tree had and this page
did not — a failed request no longer draws "No folders yet".

### Ask

`useWorkspaceChat`, thread picker, rename/delete a thread, delete an exchange,
rotating prompts, context chips, modes, citations, sources. **PRESERVED**;
presentation rewritten.

### Meeting

Masthead and its whole spec line, title editing, tags, reading modes,
template picker, rewrite, stale banner, translation, RTL, quotations, topics,
transcript (per-word seek, marks, notes, reactions, editing, speaker rename /
merge / reassign, find, marked filter, talk time, per-line language), action
items (tick, owner, due, comments, edit, delete, manual add, source seek),
decisions, risks, outline, meeting chat, export, ⋯ menu, erase audio/transcript,
processing and failure states, transport. **PRESERVED** — 62 of the meeting
page's 75 tests exist to say so, on a page that had **none** before this branch.

### Record

Every state and transition of `useRecorder`, `useSaveJob`,
`useLiveTranscript` and `RecordingSession`. **PRESERVED — provider files
byte-for-byte unchanged.**

### Import, search, notifications, settings

Drag/drop, browse, validation, duration probe, allowance, presigned upload,
progress, meeting creation, processing hand-off, inherited folder destination;
the four search operators, debounce, recent searches, transcript mentions,
keyboard navigation; the bell's unread count, filters, mark/clear, navigation;
every settings form and route. **PRESERVED**.

---

## 3 · Components retired

| Component | Why |
|---|---|
| `components/folder-tree.tsx` (+ test) | The rail's folder section. There is no rail. Its **three-state rule** was carried into `components/folder-table.tsx`, which did not have it — so retiring it *fixed* a bug rather than losing one. |
| `app/(app)/folders/page.test.tsx` | Moved to `components/folder-table.test.tsx`, every assertion intact plus nine new ones. |

Nothing else was deleted. `lib/pane-size.ts` and `components/pane-resizer.tsx`
are unused and still present — see §8.

## 4 · Components retained (behaviour untouched)

`recording-context`, `use-recorder`, `use-save-job`, `use-live-transcript`,
`use-workspace-chat`, `meeting-panels`, `resource-state`, `processing-jobs`,
`processing-stages`, `search-overlay`, `side-pane`, `header-slot`, `routes`,
`moments`, `turns`, `exports`, `zip`, `allowance`, `privacy`, `plan`,
`settings-tabs`, `days`, `format`, and every API hook in `lib/api.ts`.

## 5 · Components visually rewritten

`app-shell`, `account-menu`, `plan-usage`, `notification-bell`, `search-command`,
`import-dialog`, `recording-bar`, `audio-player`, `chat-message`, `markdown`,
`chat-composer`, `scoped-chat`, `translated-transcript`, `action-item-row`,
`insights-panel`, `folder-table`, `conversation-row`, `ui/tabs`, `ui/dialog`,
`settings/*`, and the Now, Library, Ask, meeting, record and upload pages.

**New:** `v2/app-band`, `v2/places`, `v2/mobile-tabs`, `v2/brand-mark`,
`v2/record-action`, `lib/places`.

---

## 6 · Unsupported V2 concepts — excluded

Audited by grepping the production frontend (`app/`, `components/`, `lib/`,
excluding `.test.`) and reading every hit in context.

| Concept | Production UI | Notes |
|---|---|---|
| Memory (destination, tab, cards, threads) | **none** | 19 hits, all JavaScript runtime memory or comments explaining the exclusion |
| Meeting Memory | **none** | one comment |
| Decision History, Decision Drift | **none** | 0 hits |
| Commitment Ledger, Commitments | **none** | 26 hits, all English prose in comments. **One fixed in this audit** — see below |
| Promise Journey, promises | **none** | 97 hits, all `Promise<T>` or English "promises" |
| "slipped", "reversed", "since last meeting" | **none** | one comment recording the exclusion |
| Semantic search | **none** | `POST /search/semantic` untouched and unused; `search-command.tsx` says so in its header |
| YouTube **import** | **none** | see below |
| PDF / document **import** | **none** | see below |
| Browser tab / system audio capture | **none** | 0 hits |
| Pre-recording wizard, consent checkbox | **none** | `record/page.test.tsx` has four negative assertions |

**Fixed during this audit.** `app/page.tsx` — the public landing page — read
*"Decisions and commitments"* and *"then the commitments"*. English rather than a
feature claim, but it is also the name of a V2 concept this product does not
have, and a landing page is exactly where a reader would take it for one. Both
now say **action items**, which is the product's own word everywhere else.
`app/page.test.tsx` updated with it.

**YouTube and PDF, deliberately kept as *rendering*.** `sourceType === "YOUTUBE"`
and `"DOCUMENT"` still render on a meeting and in a conversation row. There is
**no import UI** for either — the file input is `accept="audio/*,video/*"` and
nothing else. Meetings imported before those sources were removed still exist,
and a row that misreported where it came from would be a worse lie than the one
being avoided. PDF also survives as an **export** format, which is real.

---

## 7 · Behavioural differences deliberately introduced

Each was decided with the reason recorded, and each is reversible.

1. **Now = the newest 20 conversations, regardless of folder.** It used to send
   `unfiled=true` — a folder filter under a name about time — so filing a meeting
   made it vanish from the page called Recent. Both bounds are stated on screen.
2. **Library = the complete archive + folders.** The two pages differ by *how
   much they show*, which is visible, rather than by a hidden predicate.
3. **Three empty-state screens removed from Now** — *Everything is in a folder*,
   *Nothing outside your folders*, and the contradiction screen — along with the
   one-row probe and folder read behind them. All three existed to explain the
   filter that is gone. The rule underneath them is untouched and has its own
   describe block.
4. **The band is the same shape on every page.** Search, Import and Record are no
   longer withheld on Settings, on Ask or on a meeting. Those rules refereed a
   64px bar shared between global and page actions; V2 separates them. The one
   rule with a consequence — both withheld while a recording is in hand — is kept.
5. **New folder moved from the top bar to the folder list.** The band is global
   and carries nothing belonging to one page.
6. **Processing is not labelled "Needs you".** A failed transcription and a
   meeting still being made are two lines with different weight, not one block.
7. **Ask is not duplicated on Now.** The workspace chat is already in that page's
   margin with its own composer; `/ask` deliberately does not resume it.
8. **Rail and pane drag-resizing removed.** The measure is the point of the
   layout, and a pane the reader can drag is a pane that can take that width away
   one accidental grab at a time. No capability behind it.
9. **The active-recording MicrophonePicker is retained**, visually secondary, per
   explicit instruction. It switches input during a live recording; it is not a
   pre-recording chooser.

---

## 8 · Known limitations

1. **There is no view of "meetings not in a folder."** The real cost of §7.1. It
   was only ever reachable as Now's *default*, never as a filter anybody chose —
   which is what made the default a trap. If it is wanted back, the honest home is
   a folder filter on Library.
2. **Unsupported V2 Memory features are excluded** — no cross-meeting decision
   timelines, drift, commitment ledger or promise journey. `V14` and `V15` dropped
   `meeting_decisions`, `decision_links`, `decision_vectors`, `commitments` and
   `commitment_evidence`. There is no schema behind any of it.
3. **Semantic search UI is excluded.** The endpoint exists and stays unused.
4. **Unsupported import sources are excluded** — no YouTube, PDF, Drive, Dropbox,
   Zoom, Teams or Meet.
5. **`lib/pane-size.ts` and `components/pane-resizer.tsx` are unused** but still
   present with their tests. Retiring them is a deletion with no behavioural
   change; left in the tree rather than removed in the same pass as the audit.
6. **`--rail-w` is still published as `0px`** by the shell. Both consumers are
   gone; the variable can be dropped in a follow-up.
7. **CSS layout at each viewport is browser QA, not automated.** See §9.
8. **Geist Mono → JetBrains Mono.** The V2 design specified Geist Mono; it is not
   in Next 14.2.15's Google Fonts data.

---

## 9 · Responsive behaviour

Same Next.js web application at every width. **No native app of any kind** — no
React Native, Expo, Flutter, Swift, Kotlin, iOS or Android project, no APK, no
IPA, no store configuration.

| Width | Behaviour |
|---|---|
| 1440 / 1280 | Band + the spread: 680 measure with the 400 margin from 1160px up |
| 1024 | Margin folds into the measure (`minmax(0, 680)`); side pane still a column from `lg` (1024px) |
| 768 | Side pane stacks under the page; band keeps the three places from `md` |
| 390 | Bottom tabs (Now/Library/Ask/Record, 56px); band keeps Search, Import, notifications, account; page scrolls as one document |

- The reading column is `width: 100%; max-width: 680px` with page padding —
  never a forced minimum.
- The bottom tabs lift above the recording bar via `--recording-bar`, so Stop and
  Pause are never covered and navigation is never obscured.
- Dialogs are capped at `calc(100dvh - 2rem)` with `overflow-y-auto`; the close
  button is a 40px target.
- No duplicated global actions and no second mobile state — one Ask surface, one
  recorder, one search overlay.

**Needs manual browser verification** (CSS, not logic): the five viewports
against long meeting titles, long folder names, long speaker names, a long
transcript, a long AI answer, many action items, none, decisions only, risks
only, neither, a processing meeting, a failed meeting, an empty account, and many
folders.

---

## 10 · Backend impact

**None.**

```
git diff --name-only 58a00d0^..HEAD -- backend-spring/ ai-service/
(empty)
```

No data model, endpoint, request shape or contract changed. `MeetingListQuery.unfiled`
and `POST /search/semantic` both remain on the server, simply without a caller.

---

## 11–16 · Verification

| | Result |
|---|---|
| **Test files** | **120** |
| **Total tests** | **2276**, all passing |
| **Typecheck** (`tsc --noEmit`) | clean |
| **Lint** (`next lint`) | clean apart from the pre-existing warnings below |
| **Production build** (`next build`) | ✓ Compiled successfully |
| **Pre-existing warnings** | 2, both `react-hooks/exhaustive-deps` for `setConversationId` — `app/(app)/meetings/[id]/page.tsx` and `lib/use-workspace-chat.ts`. Present before this branch, untouched by it. |

No `any`, no `@ts-ignore`, no `eslint-disable` was added to make any of this pass.

### Tests added by this branch

| File | Tests |
|---|---|
| `app/(app)/meetings/[id]/page.test.tsx` | 75 — the largest screen in the product, which had **none** |
| `components/app-shell.test.tsx` | 27 — the shell, which had **none** |
| `components/v2/app-band.test.tsx` | 18 |
| `components/folder-table.test.tsx` | 26 |
| `components/v2/mobile-tabs.test.tsx` | 9 |
| `app/(app)/library/page.test.tsx` | 9 |
| `components/recording-survives-navigation.test.tsx` | 4 |

**No test was deleted to make the suite green.** Three files changed direction
(`lib/chrome.test.ts`, `components/account-menu.test.tsx`,
`app/(app)/folders/page.test.tsx`); in each case the rule was re-asked of what
replaced it, and the reasoning is recorded in the file itself.

---

## Cross-phase regression checks

| Path | Covered by |
|---|---|
| Record → navigate → recording survives | `recording-survives-navigation.test.tsx` (4) — counts provider mounts across real route changes |
| Folder → Import → destination inherited | `app-shell.test.tsx` "files into the folder the page is inside" |
| Folder → Record → meeting destination | `app-band.test.tsx` / `mobile-tabs.test.tsx` — `recordHref` + `setReturnTo` both carry `/folder/prj_1` |
| ⌘K after navigation, one listener | `app-shell.test.tsx` — 8 routes walked; added-once, removed-on-unmount, not rebound on navigation |
| Summary citation → Transcript | `meetings/[id]/page.test.tsx` "makes an anchored outline heading play from its moment" |
| Transcript word → seek | `meetings/[id]/page.test.tsx` "gives every word its own seek target" |
| Action item source → seek here | `meetings/[id]/page.test.tsx` "plays the sentence here rather than opening the meeting again" |
| Notification → navigation | `notification-bell.test.tsx` |
| Logout | `account-menu.test.tsx` "logs out" |
