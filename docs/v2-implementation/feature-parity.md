# V2 → production — feature parity matrix

*Written before any production file was modified. The rule it enforces:*

> **The repository is the functional source of truth. The V2 design is the visual and IA source of truth.**

Every row below was checked against `frontend/lib/api.ts` (82 endpoints), the route files, the components that call them, and the 115 test files. Nothing here is inferred from a screenshot.

---

## 0 · What the production app actually is

| | |
|---|---|
| Routes | `/` `/sign-in` `/sign-up` `/sso-callback` `/welcome` · `/home` `/ask` `/folders` `/folder/[id]` `/meetings/[id]` `/record` `/upload` `/settings/[[...tab]]` (+ legacy `/billing` `/privacy`) |
| Shell | 256px resizable rail · 64px top bar · 448px resizable side pane · docked `RecordingBar` · docked `ProcessingDock` |
| Rail contents | wordmark + `NotificationBell` · NAV (Home, AI Chat) · `FolderTree` · `PlanUsage` · `AccountMenu` |
| API surface | 82 RTK Query endpoints |
| Tests | 115 files, 2 126 tests |
| **Untested surfaces** | **`app-shell.tsx` and `meetings/[id]/page.tsx` have no test file.** The two largest things this redesign touches are exactly the two with no safety net. Tests are added for both. |

---

## 1 · Navigation and destinations

| V2 surface | Verdict | Production mapping | Notes |
|---|---|---|---|
| **Now** | REMAP | `/home` | Same route, same hooks (`useGetMeetingsQuery`, `useGetProjectsQuery`, `useGetActionItemsQuery`). Restyled and re-scoped — see §3. |
| **Library** | REMAP | new `/library` route over `useGetMeetingsQuery` + `useGetProjectsQuery` | **No new backend.** It is Home's existing *All Conversations* scope, relocated, with the folder list in its margin. `/folders` and `/folder/[id]` survive untouched underneath. |
| **Ask** | KEEP | `/ask` | `useWorkspaceChat`, `ChatComposer`, `ChatHistory`, `SourceList` all preserved. |
| **Memory** | **REMOVE** | — | No `meeting_decisions`, `decision_links`, `decision_vectors`, `commitments` or `commitment_evidence` in the schema (`V14`, `V15` dropped them). The destination, the reading mode, the threads and every margin note that carried a cross-meeting relationship are removed. |
| Band: Search / Import / Record | KEEP | `openSearch()`, `ImportDialog`, `RecordButton` | They are actions in the band, not destinations. Unchanged behaviour. |
| Band: Notifications, account | KEEP | `NotificationBell`, `AccountMenu` | Move from the rail into the band; behaviour identical. |
| Places underline (from concept B) | KEEP | — | Purely visual. |

**Three destinations, and the third is Ask, not Memory:** `Now · Library · Ask`.

### Route consequences

| Route | Fate |
|---|---|
| `/home` | Kept. Becomes **Now**. |
| `/library` | **New route.** Client-only; no new endpoint. |
| `/folders`, `/folder/[id]` | Kept, restyled, reachable from Library's margin and from `⌘K`. |
| `/ask`, `/meetings/[id]`, `/record`, `/upload`, `/settings/*`, `/welcome`, auth routes | Kept. |
| `/billing`, `/privacy` | Kept as legacy redirects into `/settings` (`LEGACY_PATHS` already does this). |

---

## 2 · V2 concepts that are **not implemented**

Every one of these was in the approved design and is removed from production because the code does not support it. None is left visible-but-disabled.

| Removed | Why |
|---|---|
| Memory destination, Memory reading mode, memory index | tables dropped in `V14`/`V15` |
| Decision history · decision drift · decision reversal · "reverses 12 August" | no cross-meeting decision store |
| Promise journey · commitment ledger · "slipped twice" · promised/kept/slipped lifecycle | `commitments` dropped; a promise **is** an action item — one store, not two |
| "What Reverie noticed" on Now · overnight intelligence | nothing computes it |
| Cross-meeting relationship counts on a meeting row (the iris `⇄ 6`) | same |
| Interval labels on a thread ("14 days later") | no thread |
| Margin notes carrying a *cross-meeting* relationship | same — **but the margin itself survives with real anchored data, see §4** |
| Memory tallies on Now ("2 decisions moved", "1 risk open 13 days") | not derivable |
| Semantic-search UI, embedding ranking, "Search memories" | `POST /search/semantic` exists and is called by nothing; the search UI has two result kinds |
| Search categories: decisions, promises, people, folders | `ShownGroupKey = "meetings" \| "mentions"` |
| Microphone picker, capture-source wizard, consent tick, "Start recording" pre-flight | the current Record button opens the microphone directly and deliberately (see the comment in `app-shell.tsx`) — reintroducing a pre-flight would undo a decision this codebase already made |
| Import: link / YouTube / PDF / typed-up notes | `MeetingCreateRequest` takes an `objectKey`; there is no route |
| Export: subtitles (WebVTT), JSON | `ExportDialog` supports pdf, docx, md, txt, audio |
| Four settings groups (Account/Capture/Privacy/Plan) | `SETTINGS_TABS` is General + Plans |
| Speaker-profile management UI ("seven voices Reverie knows") | no endpoint reachable from the client |
| "Ask this decision's three meetings" scope | no decision store |

---

## 3 · Now — what it shows, and where every number comes from

V2's Now had a memory-derived "Needs you". That is removed. What replaces it is derived **only** from data the app already fetches.

| V2 element | Verdict | Production source |
|---|---|---|
| Greeting + date | KEEP | `useAuth()` + `Date` |
| Ask entry field | REMAP | opens the existing workspace chat (`/ask`) |
| "Needs you" — memory rows | **REMOVE** | — |
| "Needs you" — **action items** | REMAP | `useGetActionItemsQuery({ mine: true, status: "OPEN" })` — overdue first via `daysUntilDue` |
| Tally: *open* | KEEP | count of `status !== "DONE"` |
| Tally: *overdue* | KEEP | `daysUntilDue < 0` |
| Tally: *decisions moved*, *risk open N days* | **REMOVE** | not derivable |
| "Arrived overnight" / recent list | REMAP | `useGetMeetingsQuery` — the existing *Recent Conversations* scope |
| Date-window filter | KEEP | existing `DateFilter` + `WHEN_CODEC` sticky preference |
| Scope picker (Recent / All) | **RELOCATE** | *Recent* stays and is implicit; *All Conversations* moves to **Library**. Keeping both would be the duplicate library the brief forbids. `home/page.test.tsx` is updated, not deleted. |
| Processing rows | KEEP | `ProcessingRow` + `useLiveMeetingStatus` |
| Failed meeting row | KEEP | existing status handling |
| Side pane: chat \| action items | KEEP | `HomeChatPanel`, `ActionItemsPanel` — becomes the V2 margin |
| Empty states (5 variants) | KEEP | `homeListState` already distinguishes them |

### 3a · What "Needs you" actually became — done in phase 3

The remap above proposed action items: `{ mine: true, status: "OPEN" }`, overdue first, with *open* and *overdue* tallies. That was written before two facts about the production data made it dishonest on this screen:

- **`mine` matches against the display name in Settings**, which is empty until somebody sets one. A tally reading "0 open" over an account with a dozen open items is worse than no tally.
- **The panel in the margin is `standalone: true` only** — items somebody typed for themselves, not what a transcript produced. A workspace-wide count above a three-row list contradicts the thing under it. And a standalone item is created from a title alone, so it carries no `dueOn`: an *overdue* figure there would be a permanent zero.

What ships instead is derived from the page's own list, costs no extra request, and cannot be wrong: **how many conversations are still being made, and how many could not be**. A failed transcription is the one thing on Now that genuinely needs a human, and it was previously findable only by scrolling for a red badge. `Masthead` in `app/(app)/home/page.tsx`.

The Ask entry field from the V2 concept is **not** built. The workspace chat is already in this page's margin with its own composer; a second field on the page opening a *different* thread on `/ask` — which deliberately does not resume the margin's conversation — is two chats a centimetre apart. Ask stays a place in the band.

### 3b · The scope picker, relocated

`All Conversations` is `/library`. `Recent` has no picker above it any more, which makes the line under the heading the whole of the explanation for why a meeting recorded inside a folder is not in a list called Recent — it was the hint inside the picker's menu. `home/page.test.tsx` keeps every rule those tests held: `unfiled=true` is still asserted on the wire, the sticky-preference session defect is re-asked of the date window (identical `useStickyPreference` machinery), and the probe behind the empty states is unchanged. "Show all conversations" is a **link to Library**, not a control that flips a filter.

`home.scope.v2` is left in storage rather than cleared. Nothing reads it, and clearing it would mean a write on load from a page whose whole problem once was doing something surprising on load.

---

## 4 · The margin — the signature V2 mechanism, kept honest

V2's margin held cross-meeting memory. That is gone. **The margin survives because real anchored data exists:**

| Margin content | Anchored by | Endpoint |
|---|---|---|
| Highlight / bookmark / note | `startSeconds` on the moment | `getMoments` ✅ |
| Action item | `sourceStartSeconds` | `getMeetingActionItems` ✅ |
| Decisions & risks | `sourceSection` — **not** a timestamp | `getInsights` ✅ — so these live in a **section of the Brief**, not anchored in the transcript margin |

So the transcript keeps its 680 + 40 + 400 spread and the notes in it are real. On Now the margin is action items and processing; on Library it is folders; on a folder it is that folder's meetings count and its scoped chat.

Where a meeting has no moments and no anchored action items, **the margin collapses and the measure centres** — rather than showing an empty column.

---

## 5 · The meeting page

| V2 element | Verdict | Production mapping |
|---|---|---|
| Masthead: title, date, duration, voices | KEEP | `MeetingTitle`, `MeetingTags`, `meeting.*` |
| Title editing | KEEP | `useUpdateMeetingMutation` |
| Back to folder | KEEP | existing `folderHref` |
| Reading modes: **Brief / Transcript** | REMAP | the existing two tabs, restyled |
| Reading mode: **Memory** | **REMOVE** | — |
| Player: transport, scrub, waveform, marks, speed, volume | KEEP | `AudioPlayer` + `useAudioController`; marks come from `getMoments` |
| Who-spoke-when strip | REMAP | drawn from real segment speakers in `getTranscript` |
| Brief: lead, sections | KEEP | `getSummary` + `SummarySectionView` |
| Brief: template picker | KEEP | `getSummaryTemplates`, `resummarize` |
| Brief: regenerate | KEEP | `useResummarizeMutation` |
| Brief: key moments | REMAP | rendered from real summary sections, not invented |
| Brief: decisions | KEEP | `getInsights` kind `DECISION` + add/edit/delete |
| Brief: risks | KEEP | `getInsights` kind `RISK` |
| Brief: action items | KEEP | `getMeetingActionItems`, `createActionItem`, `patchActionItem` |
| Brief: pulled quotations | **REMOVE** | no quotation store; summary sections are the real content |
| Brief: "six things this meeting changed" notice | **REMOVE** | memory |
| Brief: topics row | **REMOVE** | not in the summary contract |
| Transcript: turns, speakers, timecodes | KEEP | `getTranscript` |
| Transcript: run attribution (name once) | KEEP | presentation only — grouping consecutive same-speaker segments |
| Transcript: playback highlight, click-to-seek | KEEP | existing word-timing behaviour |
| Transcript: edit | KEEP | `TranscriptEditor` + `editSegments` |
| Transcript: rename / reassign / merge speaker | KEEP | `renameSpeakers`, `setSegmentSpeaker`, `mergeSpeakers`, `ReassignSpeakerDialog` |
| Transcript: selection menu | KEEP | `SelectionMenu` |
| Transcript: turn actions (highlight, note, copy, link) | KEEP | `TurnActions` + `createMoment` |
| Transcript: translation | KEEP | `TranslationDialog`, `TranslatedTranscript`, `getTranslations`, `translateMeeting` |
| Outline | KEEP | `OutlineNav` — becomes the summoned `⌘.` overlay |
| Ask this meeting | KEEP | `getChat`, `askChat`, meeting conversations |
| ⋯ menu | KEEP | `MeetingMenu` — rename, move, regenerate, change language, copy summary/transcript/link, delete |
| Export | KEEP | `ExportDialog` — **pdf, docx, md, txt, audio only** |
| Erase audio / erase transcript | KEEP | `eraseAudio`, `eraseTranscript` |
| Processing state | KEEP | `ProcessingCard`, `processing-stages`, `subscribeMeetingStatus` |
| Failure state | KEEP | `MeetingLoadError`, `reprocessMeeting` |
| Plan / allowance state | KEEP | existing |

---

## 6 · Recording

| V2 element | Verdict | Note |
|---|---|---|
| Pre-flight screen (title, folder, mic picker, allowance) | **REMOVE** | Record opens the microphone directly. The title and folder are already handled by `useRecordingSession` and `returnTo`. |
| Band turns while recording | KEEP | visual only |
| Elapsed timer, live waveform | KEEP | `RecordingBar`, `useRecorder` |
| Live transcript | KEEP | `use-live-transcript`, `LiveTurn` |
| Pause / resume / stop / discard | KEEP | `RecordingProvider` |
| Survives navigation | **KEEP — critical** | `RecordingProvider` wraps the shell; not refactored |
| Docked controller when elsewhere | KEEP | `RecordingBar` restyled |
| Allowance refusal | KEEP | `recordRefusal`, `useAllowance` |
| "Stop and save" dialog | REMAP | existing save/discard flow, restyled |
| Processing hand-off | KEEP | `trackProcessing`, `ProcessingDock` |

---

## 7 · Import, search, notifications, settings

| V2 element | Verdict | Production mapping |
|---|---|---|
| Import: audio/video file, drag-drop, browse | KEEP | `ImportDialog`, `createUploadUrl`, `createMeeting` |
| Import: duration probe, validation, progress | KEEP | existing |
| Import: files into the current folder | KEEP | `chrome.folderId` → `ImportDialog projectId` |
| Import: link / document tabs | **REMOVE** | no route |
| `/upload` full form | KEEP | still linked for filing into a project |
| Search: `⌘K`, recent searches, facets, keyboard nav | KEEP | `SearchCommand`, `getSearchFacets`, `recent-searches` |
| Search: meetings + transcript mentions | KEEP | the two real groups |
| Search: jump to timestamp | KEEP | existing deep link |
| Search: ask-the-question first row | **REMOVE** | would need a search→chat bridge that does not exist |
| Search: semantic / decisions / promises / people | **REMOVE** | — |
| Notifications | KEEP | `NotificationBell` and its six endpoints |
| Settings: General, Plans | KEEP | `SETTINGS_TABS` unchanged; rows restyled |
| Settings: four groups | **REMOVE** | two tabs is what exists |
| Plan / usage | KEEP | `getUsage`, `PlanUsage` — moves out of the rail into the account menu and Plans tab |
| Privacy, retention, account deletion | KEEP | `getPrivacyOverview`, `updateRetention`, `closeAccount` |
| Auth: sign in / sign up / SSO / welcome | KEEP | Clerk; `AuthShell`, `AuthForm` restyled only |

---

## 8 · Shell behaviours that must survive the rewrite of the JSX

`app-shell.tsx` is being replaced. These are its behavioural responsibilities, each of which is carried over:

1. `RecordingProvider` wrapping everything — **recording survives navigation**
2. `⌘K` bound at the shell, works from any focus
3. `openSearch` / `closeSearch` store, so "search in folder" can open it pre-filled
4. `ImportDialog` mounted at shell level with `chrome.folderId`
5. `FolderDialog` for New folder
6. `RecordingBar` and `ProcessingDock` docked at window level
7. `--recording-bar` clearance so pages end above the bar
8. `HEADER_SLOT_ID` portal for page-owned header controls
9. `SIDE_PANE_ID` portal for page-owned margin content
10. `headerChrome(pathname, capturing)` deciding what the bar shows
11. Mobile drawer / responsive collapse
12. `AuthGate`

**Retired (visual only, no capability lost):** rail and pane drag-resizing (`PaneResizer`, `usePaneWidth`). V2 has no resizable columns — the margin is a fixed 400px and the rail no longer exists. `pane-size.ts` and `pane-resizer.tsx` are kept in the tree with their tests until the final sweep, then removed if nothing references them.

### 8a · What actually happened to items 5, 10 and 11 — done in phase 2

Nine of the twelve carried over unchanged. Three did not survive in the form written above, and each is a decision rather than an omission.

**5 · `FolderDialog` for New folder — moved to the page, not dropped.** The dialog was mounted by the shell because the *header* opened it, and the header was per-page. The band is not: it carries the same five controls on every screen, so a New folder button in it would be offering one page's action from all of them. The button and both dialogs (create, rename) now live on `/folders`, beside the list they act on. `folders/page.test.tsx` reverses its "does not put a New folder button above the list" assertion and pins the thing that assertion was protecting — that there is exactly **one** of them above the list.

**10 · `headerChrome` → `bandChrome`.** The old rulebook existed to referee a 64px bar shared between global actions and the page's own. V2 separates them — the band is global, page actions render in the page — which dissolves the reason for most of the rules. What is left is one rule and one lookup:

| Old rule | Now | Why |
|---|---|---|
| search hidden on Account Settings | **search everywhere** | a band that drops a control on one navigation reads as broken chrome, which is worse than a control that finds nothing on one page |
| Import/Record hidden on `/ask` | **offered** | they left that page because they crowded its composer in a shared bar; they do not share a bar with it now |
| Import/Record hidden on a meeting | **offered** | they left because five buttons in a row read as one toolbar when they were two; the meeting's own Share/Export are no longer in the same row |
| Import/Record hidden on Settings | **offered** | same as search — shape constancy beats the "different sittings" argument once the bar is global |
| `create: "folder"` on `/folders` | **removed** | see item 5 |
| `bare` for the empty settings bar | **removed** | structural now: the page-action row has no height of its own, so a page with nothing in it contributes zero pixels rather than needing a flag |
| **Import/Record withheld while recording** | **kept** | the only rule with a consequence rather than an opinion. Record would offer to start what is already running; Import is a file picker over a live microphone |
| `folderId` from the path | **kept** | Import files into it, and the folder's own rename/delete render beside the page |

`lib/chrome.test.ts` was rewritten rather than trimmed: it walks the same URL sets (every settings tab, every legacy path, both `/record` forms) against the new expectations, and absorbs the `placeFor` cases so the two halves of "what does the band show here" cannot drift into contradicting each other.

**11 · Mobile drawer → bottom tabs.** The hamburger slid the entire 256px desktop rail in over a scrim: navigation behind a gesture, in the corner furthest from a thumb, showing a folder tree and an allowance meter to somebody who wanted the chat. `components/v2/mobile-tabs.tsx` is the same three places as the band in the same order, plus Record as a fourth — and it lifts above the recording bar via `--recording-bar` rather than sitting under it.

### 8b · Where the rail's other contents went

| Was in the rail | Now |
|---|---|
| Home / AI Chat links | Now / Library / Ask, in the band |
| `FolderTree` | **deleted in phase 4.** Library absorbed the folder list and `/folders` is a redirect; the tree's rail shape (collapsible section, uppercase heading, hover-reveal plus) has no home in V2. Its three-state rule — `undefined` is a skeleton, not an empty account — was carried into `components/folder-table.tsx`, which did not have it. See implementation-notes, phase 4. |
| `NotificationBell` | band, right group — 32px, `align="end"` so a 24rem panel does not hang off the right edge |
| `PlanUsage` | **inside the account menu.** An allowance nobody sees until they have run out of it is not a meter |
| `AccountMenu` | band, far right. The trigger is the avatar alone; the name, the address and "Development session" are the first two lines of the menu, so nothing was dropped in the move |

---

## 9 · Terminology

The V2 prototype used its own words. Production keeps production's, except where the rename is safe and total.

| V2 word | Production word | Decision |
|---|---|---|
| Promise | **Action item** | keep production's — one model, one word |
| Memory relationship | — | removed |
| Moment / mark | **Moment** (`TranscriptMoment`) | keep production's |
| Folder | **Folder** (`Project` server-side) | already reconciled in the client; unchanged |
| Brief | **Summary** | keep production's tab label "Summary"; V2's editorial layout applies |
| Recall | **Search** | keep production's |
| Now | Home route, "Now" label | label only |

---

## 10 · Test strategy

| Category | Handling |
|---|---|
| **A — behaviour survives, markup changed** | update selectors/roles, keep the assertion. Expected for most of `home`, `folders`, `folder/[id]`, `search-command`, `insights-panel`, `action-items-panel`. |
| **B — presentation-only test** | rewrite around behaviour. |
| **C — surface intentionally removed** | only where V2 removes something *that was already dead*. **No production capability is being removed**, so this category should be near-empty. The one real entry is Home's *All Conversations* scope, which is **relocated to Library, not deleted** — its test moves with it. |
| **New** | `app-shell` (band, places, ⌘K, record survival, portals) and the meeting shell, neither of which has any test today. |

**No test is deleted to make the suite green.**

---

## 11 · Implementation order

1. tokens + Tailwind theme (no component changes) — the whole app inherits the V2 palette at once
2. shell + band + navigation
3. Now
4. Library + folders
5. Ask
6. meeting shell, masthead, player
7. Summary
8. Transcript
9. action items, decisions, risks, moments
10. recording + `RecordingBar`
11. import
12. search
13. notifications, account, settings, auth
14. responsive
15. tests, accessibility, regression

`npm run typecheck && npm run lint && npm test` after each phase.
