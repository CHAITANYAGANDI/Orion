# V2 production implementation — notes

Running record of decisions that a reader of the diff would otherwise have to
reconstruct: deviations from the V2 prototype, things deliberately left for a
later phase, and the two or three places where the design and the code
disagreed and the code won.

Companion documents:

- [`feature-parity.md`](./feature-parity.md) — the gate. What production does,
  what V2 adds, and what is removed with the reason.
- `final-parity-audit.md` — written at the end, against the finished build.

---

## Phase 1 — tokens and the Tailwind theme

**Committed as `58a00d0`.**

### One set of values, two sets of names

`app/globals.css` is rewritten around the V2 palette, and `tailwind.config.ts`
exposes it twice: under the shadcn names the existing components already use
(`--background`, `--card`, `--border`, `--primary`) and under the V2 semantic
names new work uses (`--surface-*`, `--ink-*`, `--brand-*`).

This is what makes the migration survivable. A screen that has not been rebuilt
yet still renders in the V2 palette rather than in whatever the old variables
happened to hold, so there is never a commit where half the app is dark and half
is not.

`--primary` points at `--ink`, **not** at the brand. The accent means "Reverie
noticed this" or "Reverie is doing this"; a Save button is neither, and an accent
spent on every button is an accent that means nothing.

### Deviation: Geist Mono → JetBrains Mono

The V2 design specifies Geist Mono, which is narrower and reads less like a code
editor beside a person's name. It is **not in Next 14.2.15's Google Fonts data**
— verified by grepping `next/dist/compiled/@next/font/dist/google/font-data.json`;
Schibsted Grotesk and Literata are both there, Geist Mono is not. Self-hosting a
family for that much of a gain is not worth the first-paint cost, so JetBrains
Mono stands in. Recorded in `app/layout.tsx` beside the import.

### All three faces load as variable fonts

`weight` is deliberately omitted in every `next/font/google` call, which is what
makes it fetch the variable cut. The interface uses **420** for body and **560**
for its emphasised weight, and neither exists as a static instance: with a fixed
weight list they would snap to 400 and 500, and the one real hierarchy level
between body and headline would disappear.

### No `dark:` variant

`darkMode: []`. There is one palette on `:root` and no light one to vary from, so
a `dark:` utility would compile to a rule keyed on a class nothing adds — and
would therefore silently never apply.

---

## Phase 2 — the shell, the band, and Library

### What was removed, and what it cost

A 256px rail and a 64px header — 320px of permanent chrome on a 1440px window —
became a 48px band. Everything the rail held has a new address; the table is in
[`feature-parity.md` §8b](./feature-parity.md).

The `headerChrome` rulebook went with the header it refereed. `lib/chrome.ts` is
now six lines: whether the band offers to make a meeting (false only while one is
in hand) and which folder the page is inside. Every rule that was dropped is
listed with its original argument in §8a, so none of them is being re-litigated
from silence later.

### Three tests changed direction, and none was deleted

- `lib/chrome.test.ts` — rewritten around `bandChrome`, walking the same URL sets
  (every settings tab, every legacy path, both `/record` forms) against the new
  expectations. It also absorbed `placeFor`, so "what does the band show here"
  and "where does the band say I am" cannot drift apart.
- `components/account-menu.test.tsx` — the same assertions, asked one click
  later. The trigger is the avatar alone now, so the facts that were printed on
  the button (name, address, "Development session") are checked inside the menu.
  The chevron test is replaced by an `aria-expanded` test: the bug it was written
  for was that nothing read Radix's `data-state`, and that fix survives the arrow
  being dropped in the one way that is announced rather than merely drawn.
- `app/(app)/folders/page.test.tsx` — "does not put a New folder button above the
  list" is reversed, and replaced by a test that there is exactly **one** of them,
  which is what the original was protecting.

Three new files cover what the rewrite touched and nothing tested before:
`components/app-shell.test.tsx` (18), `components/v2/app-band.test.tsx` (18),
`components/v2/mobile-tabs.test.tsx` (9), plus
`app/(app)/library/page.test.tsx` (13).

### Deliberately left for a later phase

| Thing | Why it is still here | Phase |
|---|---|---|
| `--rail-w`, published as `0px` | `components/recording-bar.tsx` and the meeting page's mini player both read it. Dropping the variable before those are rebuilt would put two fixed elements under a rail that no longer exists. | 6, 10 |
| `components/folder-tree.tsx` | Unused from this commit. Its shape is a rail section — collapsible, uppercase heading, hover-reveal plus — and it has no home in V2. Retired when Library absorbs the folder list. | 4 |
| `lib/pane-size.ts`, `components/pane-resizer.tsx` | Unused from this commit. The pane is a fixed 26rem now: the measure is the point of the layout, and a pane the reader can drag is a pane that can take that width away one accidental grab at a time. | 15 |
| Home's *All Conversations* scope | Library is the destination for it, but relocating the scope is Home's own rebuild. Shipping Library while Home still offers the same list is a duplicate for one phase, rather than a page with nothing in it. | 3 |
| `/folders` as its own route | Library links to it. The two merge when Library is rebuilt around the measure; doing it now would mean touching `folder/[id]`, `folder-header-actions`, `meeting-menu` and three test files in a commit that is about the shell. | 4 |
| The shell's `max-w-doc` container | Pages lay out their own measure in V2, but they have not been rebuilt yet, and a page with no container at all is a line of text 1400px wide. `/home` and `/ask` already opt out of it. | 3–13 |

### Small things worth knowing

- **`--tabbar: 56px`** joins `--band: 48px` in `globals.css` §7. The bottom tabs
  are fixed at `bottom: var(--recording-bar, 0px)`, so they sit on the bottom
  edge normally and lift by exactly the recording bar's height while one runs.
  Pages clear `calc(var(--dock) + var(--tabbar))` below `md` and `var(--dock)`
  above it.
- **The page-action row has no height of its own.** `FolderHeaderActions` and the
  `HEADER_SLOT_ID` portal target both carry their own padding, and the target is
  `empty:hidden`, so a page that puts nothing there contributes zero pixels. That
  was the `bare` flag's whole job, and it is structural now rather than a rule.
- **`h-[calc(100vh-4rem)]` → `h-[calc(100vh-var(--band))]`** on `/home` and
  `/ask`, which were the only two places that hardcoded the old header height.
- **`ConversationRow` moved** from `app/(app)/home/page.tsx` to
  `components/conversation-row.tsx`, unchanged. Home and Library are the same
  list under different filters, and two drawings of one row is how a status pill
  ends up on one screen and not the other.
- **`useStartRecording`** (`components/v2/record-action.tsx`) is a hook rather
  than a button because there are two buttons now — the band's and the fourth
  bottom tab. Two copies of that logic drift, and the copy that drifts is the one
  on the phone.

### Verified at the end of the phase

`npm run typecheck` clean · `npm run lint` clean (two pre-existing
`exhaustive-deps` warnings, both untouched) · `npx vitest run` 119 files, 2207
tests, all passing · `npm run build` succeeds, `/library` prerendered at 1.95 kB.

### Not touched

`backend-spring/` and `ai-service/` are unchanged. Nothing in this phase needed a
server change, and nothing in the parity matrix suggests a later one will.

---

## Phase 3 — Now

### The scope picker became a page, and a third of a test file moved with it

`All Conversations` is Library. What is left on Home is one list, `unfiled=true`,
with no control above it — so the line under the heading ("Everything outside
your folders. The rest is in Library.") is now the whole of the explanation for
a list that hides filed meetings. It was the hint inside the picker's menu, and
the file it lived in said in as many words: *do not drop it*. It is not dropped;
it is promoted.

`home/page.test.tsx` went from 1045 lines to 51 tests, and no rule was lost:

- **"the wire says unfiled"** — still asserted, now unconditionally.
- **"a stored choice survives a visit and not a sign-in"** — re-asked of the date
  window. The production defect it was written for was a value stored under
  session 1 still being reported as ready under session 2, which is a property of
  `useStickyPreference`, not of the scope. The window goes through the identical
  machinery.
- **"an empty Recent must say which filter emptied it"** — unchanged, including
  every probe state: workspace unknown, folder list unknown, folder list failed,
  no folders at all. `Show all conversations` is now a **link to Library** rather
  than a control that flips a filter.

What can no longer be asked here is what happens when All is chosen. That is
`app/(app)/library/page.test.tsx`, which pins the thing that matters: Library
asks for everything, and an inherited `unfiled` would make it a second Home.

### "Needs you" — the parity matrix was wrong, and this is why

See [`feature-parity.md` §3a](./feature-parity.md). The short version: `mine`
matches an unset display name, and the margin's panel is standalone-only with no
due dates, so both proposed tallies would have been numbers that contradict the
list beside them. What ships is derived from the rows already on screen — how
many are still being made, how many failed — which costs no request and cannot
disagree with anything.

### The greeting is computed after mounting, deliberately

`/home` is prerendered as static content. A greeting computed during render
would be baked at **build** time — "Good evening" at nine in the morning, for
everybody, until the next deploy — and would mismatch on hydration. So it is
`null` until an effect has run, and both lines reserve their height so the list
underneath does not move when it arrives.

### Verified at the end of the phase

`npm run typecheck` clean · `npm run lint` clean (same two pre-existing warnings)
· `npx vitest run` 119 files, 2202 tests, all passing · `npm run build` succeeds.


---

## Phase 4 — Library and folders

### `/folders` is a redirect, and the tree is gone

A folder is a way of grouping what you have, so it belongs on the page called
what you have. With the rail gone, a separate route for folders would have been
a destination with no entrance.

- `components/folder-table.tsx` — the old `/folders` page body, moved.
- `app/(app)/folders/page.tsx` — `redirect(LIBRARY)`. Not deleted: that URL is
  bookmarks, a link on the meeting menu somebody may have open, and the
  destination of a folder deletion in a tab that has not been reloaded. A 404 for
  any of those is a worse answer than the page they were going to.
- `components/folder-tree.tsx` and its test — **deleted**. It was the rail's
  folder section: collapsible, uppercase heading, hover-reveal plus. There is no
  rail.

Every link that pointed at `/folders` now points at `/library` —
`folder/[id]/page.tsx` (two), `folder-header-actions.tsx` (the destination after
a delete), `meeting-menu.tsx` ("Create one →"). `lib/routes.ts` keeps the
`FOLDERS` constant, because the redirect page names it and `isFolderListPath`
still has to recognise the URL on the way through so the band underlines Library
rather than nothing.

### The tree's tests outlived the tree, and fixed a bug on the way

`FolderTree` had a rule the `/folders` page did not: `projects ?? []` reads *no
answer* as *the answer is none*, so an unresolved request, a dropped connection
and a 500 all drew "No folders yet" — an explanation of what folders are for,
shown to somebody who has twenty. The tree was fixed for that; the table never
was.

So `FolderTable` decides with `resourceState` + `presenceOfList` first and turns
data into rows second, and `components/folder-table.test.tsx` carries **both**
sets: every assertion from `folders/page.test.tsx` unchanged, plus nine new ones
covering skeleton / error+retry / stale-rows-beat-a-failed-refetch / genuinely
empty. Deleting the tree's tests with the tree would have quietly un-fixed this.

`lib/session-transition.test.tsx` — the integration test that mounts the real
production nesting — followed the component. It rendered `FolderTree` because
that was what the production screenshot showed and because it held the
three-state opinions; it renders `FolderTable` now, for the same two reasons. Its
`/projects` fixture grew from two fields to a whole row, since the list renders
the count and the date.

### Still deferred

Library is a document page in the shell's container, not the 680 + 40 + 400
spread. The spread lands with the meeting page (phase 6), which is where the
margin has real anchored content to put in it; giving Library a margin first
would mean inventing something to fill it.

### Verified at the end of the phase

`npm run typecheck` clean · `npm run lint` clean (same two pre-existing warnings)
· `npx vitest run` 118 files, 2184 tests, all passing · `npm run build` succeeds,
`/folders` down to 143 B of redirect.


---

## Phase 4a — two parity corrections, on review

Both were raised against the phase 3 result and both were right.

### 1 · Normal processing is not "Needs you"

The masthead had no such heading, but it did put both counts in one sentence
with the failure in the danger colour — which reads as one urgent block, most of
which is the product working normally. That is how a real failure gets scrolled
past.

They are two lines now with different weight: the failure first, `text-danger`
at body size, because it is the one thing on the page a person can act on; the
processing count second, `text-ink-3` at foot size, phrased as activity rather
than as a demand. `FAILED` is terminal so the two counts name disjoint sets of
rows. Nothing was invented to fill the space — no action-item assignment, no due
dates — and the V2 treatment (position, colours, type scale) is unchanged.

### 2 · Recent now means recent

`unfiled=true` was still on the query. That made the page's name a lie in a way
nobody reports as a bug: record a meeting inside a folder, and it is filed there
and gone from the list called Recent. Removed.

**Now** = the newest `RECENT_SIZE` (20) conversations *wherever they are filed*.
**Library** = the complete archive, paged, with the folders. The two differ by
how much they show — visible — rather than by a hidden predicate.

Both bounds are stated on screen. Under the heading: "Your newest conversations,
wherever they are filed." Under the list, only when `totalElements` exceeds the
page: "Showing the 20 most recent of 214 — all of them are in Library." The
count is already on the response, so this costs no request.

**What that deleted, and what it did not.** Three empty-state screens are now
unreachable — *Everything is in a folder*, *Nothing outside your folders*, and
the *Couldn't show your conversations* contradiction screen — along with the
one-row workspace probe and the folder read behind them. All three existed to
explain the filter. The rule they were built on is untouched and has its own
describe block: only a settled, successful, genuinely empty response may claim
an empty account. That is `homeListState`, and it is what the production bug was
actually about.

**What it costs.** There is no longer any view of "meetings not in a folder".
Recorded as a real loss in [`feature-parity.md` §3b](./feature-parity.md), not
waved away. It was only ever reachable as a default rather than as a filter
anybody chose, which is precisely what made the default a trap; if it is wanted
back, the honest home for it is a folder filter on Library.

The `unfiled` assertion in `home/page.test.tsx` was **inverted, not deleted** —
it pins that Now never sends the parameter. That is the guard which makes the
removed screens unnecessary, so it is the test that has to fail first if the
parameter ever returns.

### Verified

`npm run typecheck` clean · `npm run lint` clean · `npx vitest run` 118 files,
2179 tests, all passing.


---

## Phase 5 — Ask

Everything on this page is KEEP in the parity matrix. `useWorkspaceChat`,
`ChatComposer`, `ChatHistory`, `ChatDock`, `SourceList`, the thread picker, the
rotating prompts, delete-an-exchange — all preserved, none touched
functionally. This phase is the V2 treatment and nothing else.

### The measure, and the serif

The thread was `max-w-3xl` (768px); it is `--measure` (680px) now, and so is the
composer under it. Not a rounder number: 680 at the reading size is about 74
characters, which is the measurement the whole layout protects — and it is the
same column a transcript and a brief are set in, so moving between them is not a
change of reading posture. Both regions are pinned by a test, because they have
drifted apart before and a composer a step wider than the answer above it reads
as a rendering fault.

**Answers are set in the reading serif.** `Markdown` gained a `reading` boolean
rather than taking a className, because the reading face has to *replace* the
interface size and leading rather than sit beside them — two font-size utilities
in one class list are resolved by whichever the stylesheet emits last, which is
not something a caller can reason about. The tests check that `text-sm` is
actually gone, not merely that a class was added.

### The question got quieter, and it had to

`PROMPT_BUBBLE` was `bg-primary text-primary-foreground`. Under the V2 palette
`--primary` is **ink** — near-white — because an accent spent on every button is
an accent that means nothing. That left the question a white slab beside the
answer somebody actually came for: the loudest object on the page was the
sentence they had just typed themselves.

It is `border-line bg-surface-raised text-ink` now. Still a bubble, still capped
at 85%, still right-aligned — the two things that say whose turn it is survive,
and there is a test for each so "quieter" cannot become "gone".

### Sources became a margin note

`SourceList` had a horizontal rule, an uppercase "SOURCES" label and a row of
filled chips: three devices to say one thing, stacked under every answer. It is
`.v2-note` now — one 1px stroke on the left edge and text — which is the same
treatment a citation gets in the transcript margin, so the two read as one idea.
The label is gone; a meeting title and a timecode under a rule are self-evidently
where the answer came from, and a word repeated under every answer is a word
nobody reads. Timecodes are mono and tabular.

### The composer's accent is brand, not ink

`focus-within:ring-primary/20` and the context chips were ink-tinted. They are
`brand` now, which is the one meaning the accent carries: *what Reverie will
read*. This is the composer shared by all four chat surfaces, so the meeting rail
and the Home rail inherit it — deliberately. One chat, three surfaces.

### Verified at the end of the phase

`npm run typecheck` clean · `npm run lint` clean (same two pre-existing warnings)
· `npx vitest run` 118 files, 2188 tests, all passing · `npm run build` succeeds.


---

## Phase 6 — the meeting shell, masthead and player

Deliberately **only** the shell. The brief, the transcript and the action items
are phases 7, 8 and 9, and each gets its own commit — a single refactor across
all four would be untestable and unreviewable.

### The measure is applied by the page, not by the panels

Both reading modes are wrapped in `.v2-spread`, at the page level. That is the
whole point: a brief and a transcript have to be set in the *same* 680px column,
because moving between the two modes is a change of content and not a change of
reading posture — and two panels each choosing their own width is exactly how
that stops being true. There is a test for it on the page, where it can be
wrong, rather than in either panel, where it cannot be seen.

`data-margin="empty"` for now, which centres the measure rather than sitting the
text left of a 400px gutter with nothing in it. The margin fills with real
anchored content — moments at their `startSeconds`, action items at their
`sourceStartSeconds` — when the transcript is rebuilt in phase 8.

The reading-mode switch and the controls beside it (the template picker, Edit
transcript) stay **outside** the measure. They are chrome that governs the whole
document, and chrome indented to the measure reads as part of the text.

### The transport is glass, and it is the only glass on the page

`AudioPlayer` was a `<Card>`. It floats over the transcript it is scrubbing,
which makes it the functional layer — the one thing translucency is for here —
so it is `.v2-glass` with the half-pixel white inset that actually separates a
floating layer from the words under it. Nothing else on the page is glass, so
the "never nested" rule holds by construction. A video stays inline (a video is
watched, not scrubbed past) and renders the same markup; only its position
differs.

The dock lost `lg:left-[var(--rail-w,16rem)]`. That was right while the shell
had a 256px column; the `16rem` **fallback** in it is what would have shifted
the bar right the moment the variable stopped being published. It is held to the
measure now, so the transport sits under the column it is scrubbing rather than
under the window. Tested.

`--rail-w` still has one consumer left (`components/recording-bar.tsx`, phase
10), so the shell still publishes `0px`.

### The reading-mode switch

`TabsList variant="underline"` is now the V2 device: a word, and a 2px ink rule
on a boundary the layout already has. Deliberately the same treatment the band
uses for its three places, so "which of these am I looking at" is one idea in
the product rather than two. Ink, not the accent — choosing a reading mode is
not something Reverie noticed. This is a shared primitive, so the meeting rail's
chat/outline switch inherits it.

### The largest screen in the product now has tests

`app/(app)/meetings/[id]/page.test.tsx` — 21, and none existed before. Every
panel under this page has its own file, and **every one of those passes just as
well when the page renders them at the wrong width, in the wrong tab, or not at
all**. So this covers what only the page can be wrong about: which facts are in
the masthead (and which are deliberately absent — no READY badge, no "English"
on an English meeting, no duration on a document), which reading mode is
showing, what column the document is in, and where the transport is docked.

The panels are mocked by name. Pulling them in would make this a test of forty
components that fails for thirty-nine reasons that are not this page's fault.
Phases 7–9 extend these mocks rather than standing up a second harness.

One thing worth knowing for later: `vi.mock` factories hoist above every `const`
in the file, so the RTK-Query result helpers live inside `vi.hoisted`. Without
that the suite fails to collect with an error naming `sonner`.

### Verified at the end of the phase

`npm run typecheck` clean · `npm run lint` clean (same two pre-existing warnings)
· `npx vitest run` 119 files, 2209 tests, all passing · `npm run build` succeeds.


---

## Phase 7 — the brief

Presentation only. Every capability below was enumerated from the production
code **before** a line changed, and every one still works.

### The inventory, and where each one ended up

| Capability | Kept | Now |
|---|---|---|
| Structured sections, switched on `kind` | yes | headings in sans at `title-3`, prose in the reading serif |
| `prose` / `bullets` / outline-group shapes | yes | unchanged logic; one bullet glyph across all three, where `list-disc` used to draw a different one in the legacy path |
| **Empty section keeps its heading** | yes | "Not discussed." in `ink-4` italic — a finding, not a gap |
| Outline heading → seek, only when `startSeconds != null` | yes | timecode in mono/tabular, brand on hover |
| Unanchored heading stays plain text | yes | no link to a guess |
| Topics discussed, read from `key === "outline"` | yes | quietened to a hairline and a raised surface |
| Verified quotations, playable, speaker + timecode | yes | `.v2-note` — the same 1px rule a chat citation gets |
| "Unknown speaker" fallback | yes | unchanged |
| Quotations hidden while translated | yes | unchanged |
| Pre-template summaries (`shortSummary`, `keyPoints`, `detailedSummary`) | yes | lead one step above body; the rest in the reading serif |
| Stale banner + "Rewrite it" | yes | `.v2-note[data-tone="warning"]` instead of a tinted box |
| Stale banner shows the refusal instead of the button on a spent account | yes | unchanged |
| Template picker, "Rewriting…", refusal title | yes | untouched — it is on the mode row, styled in phase 6 |
| Translation (`view = translation ?? summary`, sections from the translation) | yes | unchanged |
| RTL from `translated.rightToLeft` | yes | `dir` moved onto the new wrapper |
| `loading` / `error` + retry / `empty` / `waiting` / `generating` | yes | error and empty unchanged in wording; loading is now brief-shaped rather than one grey block |
| `onSeek` shared with transcript and chat | yes | unchanged |

Nothing was added. There are no sample sections, no placeholder boxes, and
nothing renders a heading over data the API did not return.

### The one structural change: it is a document, not a card

`<Card><CardContent>` is gone. A brief is what the page is *about* — part of the
page rather than an object on it — and a fill with a 10px radius around a body
of text is what makes a product look like a deck of cards. What separates one
section from the next is space and a heavier heading, which is what has
separated sections in printed documents for four hundred years.

The prose is in the reading serif; the headings are not. A heading is interface
— something you scan past to find the part you want — and that border is
absolute.

### Two things the tests found

Both are pre-existing behaviour that my first draft of the tests got wrong, and
both are worth writing down:

1. **A blank summary body renders as an empty brief, not as "No summary
   available."** `view = translation ?? summary` is truthy for a row with every
   field empty, so content wins. That is correct — saying there is no summary
   over a row that exists is the same class of lie as saying it over a full one
   — and "No summary available." is reachable only from a settled **404**, which
   is how `getSummary` reports absence.
2. **Following an anchored outline heading switches to the transcript.**
   `playFrom` changes tab when it is not already there. Seeking under a brief,
   where the reader cannot see the timeline, would be a control acting off
   screen.

### Coverage

`app/(app)/meetings/[id]/page.test.tsx` grew from 21 to **44** — the same
harness extended, not a second one. The summary query now goes through a switch
(`ok` / `loading` / `error` / `absent` / `stale-over-error`) because it is the
one query with more than one interesting state, and three of those states used
to render as the same screen.

`SummaryPanel` is a local function rather than an exported component, so the page
is the only place it can be exercised at all.

### Verified at the end of the phase

`npm run typecheck` clean · `npm run lint` clean (same two pre-existing warnings)
· `npx vitest run` 119 files, 2232 tests, all passing · `npm run build`
succeeds.


---

## Phase 8 — the transcript

The highest-risk migration in the redesign, and the one where a beautiful result
can be silently broken: a transcript that renders perfectly and no longer plays
from the word you clicked is a regression **no component test would see**,
because every component involved is still correct on its own.

So the inventory came first, and the wires were treated as load-bearing.

### The inventory, and where each one ended up

| Interaction / state | Kept | Now |
|---|---|---|
| Turns, grouped from consecutive same-speaker utterances | yes | unchanged grouping; each utterance still individually seekable inside the turn |
| Speaker name | yes | sans at `callout`/headline — a name is scanned, not read |
| Speaker avatar (`SpeakerAvatar`, colour from `speakerKey`) | yes | untouched |
| Turn timecode → seek | yes | mono, tabular, brand on hover |
| **Per-word seek** (`data-word`, `data-from/to/start/end`) | yes | untouched; tested |
| **Active-utterance tint**, recomputed per frame | yes | `bg-brand/10` — Reverie telling you where the audio is |
| **Active-word tint** | yes | `bg-brand/35` |
| Search-hit tint, saved-mark underline (shared hue, told apart by the underline) | yes | `warning` tokens instead of raw amber |
| `data-seg` / `data-speaker`, which `readSelection` recovers a passage from | yes | untouched; tested explicitly |
| Selection menu | yes | mounted; tested |
| Highlights, bookmarks, notes (`createMoment` / `deleteMoment`) | yes | unchanged |
| Bookmark pinned on the row once set | yes | `brand-text` |
| Reactions (`TurnReactions`, `toggleReaction`) | yes | unchanged |
| Turn-level notes | yes | `.v2-note` instead of a tinted box |
| Per-line correction (`openLine`, Enter saves, Esc cancels) | yes | reading-face textarea on a raised surface |
| Whole-transcript editor mode (`TranscriptEditor`) | yes | unchanged |
| Speaker rename (`renameSpeakers`) and merge (`mergeSpeakers`, server message shown) | yes | unchanged |
| Speaker reassignment (`ReassignSpeakerDialog`, incl. to a new speaker) | yes | mounted; tested |
| Find in transcript, match count, clear, Esc | yes | V2 input treatment |
| "Only marked" filter and the marks index | yes | quieter surface |
| Talk time, roll-call, per-speaker bars | yes | ink bars; figures mono/tabular so a column can be compared down |
| Per-line language chip | yes | hairline + mono, still only on lines that differ |
| Translated transcript + "translate on request" prompt | yes | same rule — sans name, serif words |
| `loading` / `preparing` / `error` + retry / `empty` | yes | loading is now transcript-shaped |
| Document body with no utterances (`fallbackText`) | yes | reading serif; tested |

Nothing was simplified away, nothing became read-only, and no data model or
endpoint was touched.

### The one structural change

`<Card><CardContent>` is gone, here and on the three wrappers around it (the
translated transcript, the translate prompt, the load error). An hour of speech
inside a fill with a 10px radius is the clearest possible case of a content
group pretending to be an object.

**The words are in the reading serif.** This is what the 680px measure exists
for — it is about 74 characters at the reading size — and it is the difference
between a transcript you can read and a transcript you can only search.

### Tests

`app/(app)/meetings/[id]/page.test.tsx` grew from 44 to **62**, same harness.
The transcript query joined the summary in going through a state switch
(`ok` / `error` / `absent`), and the transcript's collaborators are now mocked
*identifiably* rather than as `null`, so the page can be asserted to have
mounted each one.

Three tests earned their place immediately by failing:

1. **The fixture was inventing field names.** `aSegment` set `startTime`/
   `endTime`; `TranscriptSegment` is `start`/`end`. It typechecked through an
   `as` cast and produced a transcript with every utterance at 0:00. Only the
   timecode assertion noticed. The cast is gone.
2. **A speaker's name appears twice** — the turn heading and the talk-time
   roll-call — and they must agree. Asserted as such rather than scoped away.
3. **The find box is a `textbox` too.** The line editor is asserted as the only
   `<textarea>`, which is also the point of it: it opens *inside* a transcript
   that is still searchable and still seekable around it.

### Verified at the end of the phase

`npm run typecheck` clean · `npm run lint` clean (same two pre-existing warnings)
· `npx vitest run` 119 files, 2250 tests, all passing · `npm run build`
succeeds.


---

## Phase 9 — action items, decisions and risks

Three models, and they stay three models. Action items are action items,
per-meeting decisions are decisions, per-meeting risks are risks. Nothing was
introduced: no Commitment Ledger, no Promise Journey, no Decision History, no
Decision Drift, no reversed-decision intelligence, no cross-meeting lifecycle.
`V14` and `V15` dropped the tables all of those would have needed.

### The inventory, and where each one ended up

| Capability | Kept | Now |
|---|---|---|
| Tick an action item off (`patchActionItem` OPEN/DONE) | yes | checkbox accent is brand — the one moment on the row worth a colour |
| Title, and the strike-through when done | yes | unchanged |
| Owner, or "Unassigned" when the API returns none | yes | `ink-4` at cap size; still a fact, not a filled gap |
| Due date, `dueStatus` tone, the phrase it was said in | yes | unchanged |
| "Read from '…', said in the meeting" | yes | unchanged |
| Expand/collapse, comment count | yes | mono-ish cap sizing |
| Edit title / owner / due, Save gated on `dirty` | yes | unchanged |
| Delete, behind the overflow | yes | unchanged |
| Comments (`getActionItemComments`, add, delete) | yes | unchanged |
| Source sentence | yes | `.v2-note` + reading serif — the same 1px rule a brief quotation and a chat citation get |
| Source link → **seek here** rather than navigate | yes | tested via the `onOpenSource` wire |
| No source link when the sentence could not be placed | yes | tested |
| Add one that was never said aloud (`NewActionItemDialog`) | yes | unchanged |
| "N of M still open" / "Everything here is done." | yes | only over a settled list — tested |
| `loading` / `extracting` / `waiting` / `error` + retry / `empty` | yes | unchanged wording |
| Decisions and risks, per kind, with their count | yes | sections of the brief |
| `sourceSection` label ("blocker" vs "risk") | yes | unchanged — losing it loses the difference between what is already happening and what might |
| Add / edit / delete an insight, Enter saves, Esc cancels | yes | unchanged |
| **InsightsPanel renders nothing when there is nothing** | yes | still no empty state, deliberately |

### Two structural changes

**The action items card became a section of the brief.** What a meeting asks of
you is part of the same document as what it said; a bordered box around it made
it read as a widget parked below the summary.

**Decisions and risks stack instead of sitting in a two-column grid.** Inside the
680px measure two columns are ~330px each, which is too narrow for a sentence
about what was decided. The special case that grid needed — a lone card widened
to fill the row so it did not leave a hole — disappears with it.

`InsightsPanel` still renders **nothing at all** when a meeting produced neither.
Its own file says why in as many words, and repeats: *do not add an empty state
here*. A "No decisions were recorded" card derived from `(data ?? [])` would be
the `?? []` bug freshly introduced in the one place on the page that never had
it.

### Tests

The harness grew from 62 to **75**. `ActionItemRow` and `InsightsPanel` are now
mocked *identifiably*, which is what lets the page's own decisions be asserted:
which is mounted, in which reading mode, in what order, and what it wires into
each — specifically `onOpenSource` (there is a player on this page, so the
sentence plays here rather than opening the meeting again) and whether the
sentence was ever anchored.

One test is a guard rather than an assertion about markup: the page's text is
checked against `/commitment/i`, `/promise/i`, `/decision drift/i`,
`/decision history/i`, `/slipped/i`, `/reversed/i` and `/since last meeting/i`.
Any of those appearing means something was rendered from data that does not
exist.

The insights test's card selector (`closest("div[class*='rounded']")`) was
reanchored to `closest("section")`. Same assertion — a row must not leak from
one kind into the other — on the structure that now carries it.

One typing slip the compiler caught: `dueStatus: "none"` where the union is
`"NONE"`.

### Verified at the end of the phase

`npm run typecheck` clean · `npm run lint` clean (same two pre-existing warnings)
· `npx vitest run` 119 files, 2263 tests, all passing · `npm run build`
succeeds.

### Not touched

`backend-spring/` and `ai-service/` are unchanged across phases 7, 8 and 9. No
data model, no endpoint and no request shape was altered.


---

## Phase 10 — record

**The provider was not touched.** `lib/recording-context.tsx`,
`lib/use-recorder.ts`, `lib/use-save-job.ts` and `lib/use-live-transcript.ts`
are byte-for-byte unchanged. The /record page is presentation; the recorder,
the session, the live transcript and the save job are application state living
above the route, and they stayed there.

### The inventory

| Responsibility | Owner | Touched |
|---|---|---|
| Microphone permission request, `requesting` state | `useRecorder` | no |
| Permission denied → `error` | `useRecorder` | no |
| Active recording, pause, resume, stop | `useRecorder` | no |
| Elapsed timer (excludes paused time) | `useRecorder` | no |
| Input level → waveform | `useRecorder` | restyled only |
| Silence detection → "no audio" notice | `useRecorder` | no |
| Device list + mid-recording switch | `useRecorder` | no — see below |
| Live text, speaker turns, reconnect, error | `useLiveTranscript` | restyled only |
| Title and `returnTo`, surviving navigation | `RecordingSession` | no |
| Folder context (`returnTo` → `folderIdFrom`) | `RecordingSession` | no |
| Save → presigned upload → meeting creation | `useSaveJob` | no |
| Upload progress, `busy`, `stopping` | `useSaveJob` | no |
| Discard | page + recorder | no |
| Allowance refusal | `recordRefusal` | restyled only |
| Processing hand-off (`trackProcessing`) | `useSaveJob` | no |
| Unload guard | provider | no |
| Docked bar on every route | `AppShell` | restyled only |
| Reopening /record from the bar | `RecordingBar` | restyled only |

Nothing was added. There is no source chooser, no system-audio option, no tab
capture, no consent checkbox, no pre-recording wizard and no second "Start
recording" button — the page already opened the microphone on arrival, and its
own test file has four negative assertions keeping it that way.

### One thing to flag: the microphone picker

`UseRecorder` exposes `devices` / `deviceId` / `setDeviceId`, and
`RecordingBar` renders a `MicrophonePicker` — a glyph with the device name as a
tooltip, shown only **while a recording is running**, that switches the live
input mid-meeting.

The brief says "do NOT add: microphone device selector". This one is not being
added; it is existing, reachable, working behaviour, and it is not a
pre-recording chooser. Removing it would be removing current functionality,
which the same brief forbids. **Kept, restyled, and flagged here** — say the
word if it should go.

### The presentation

**The timer** is the largest quantity in the product now: `title-2`, mono,
tabular, so the digits do not jitter as the seconds turn over. At 13.5px it was
the same size as the word "Pause", on the one element somebody reads from across
a desk.

**The waveform is calm.** It was full-strength red across the whole card, which
turns a level meter into an alarm. Ink for sound, a hairline for silence — and
the thing that is genuinely urgent, the recording lamp beside the title, keeps
the red and gains `recpulse` (a slow breath, which stops under
`prefers-reduced-motion`).

**Stop outranks Pause.** They were the same size in opposite colours, which
reads as two equal choices; ending a meeting is the consequential one.

**The bar is glass**, like the meeting's transport — it floats over content, so
it is the functional layer.

**The bar lost `lg:left-[var(--rail-w,16rem)]`**, the last consumer of that
variable outside the shell. The `16rem` fallback is the dangerous half: it would
have shoved the bar a sidebar's width right the moment the variable stopped
being published.

**Live text is set like a transcript** — sans for who and when, serif for what
was said, in the 680px measure. It is the same document arriving a few seconds
early, and it should read like it.

### The regression test that matters

`components/recording-survives-navigation.test.tsx` — new, 4 tests, and it mocks
**nothing** about the provider.

`useRecorder` tears down its streams when the component holding it unmounts, so
the property being defended is *structural*: the provider must not be remounted.
Nothing about `useRecorder` in isolation can see that, and neither can
`app-shell.test.tsx`, which mocks the provider to a passthrough.

So this file counts mounts of the three hooks the real `RecordingProvider` owns
and drives real route changes through the real `AppShell`:

- `/record` → `/library` — recorder mounted **once**, bar still reads `recording`
- `/now` → `/meetings/:id` — a route with a side pane and one without
- `/now` → `/ask` — the live transcript and the save job are not rebuilt either
- `/settings/plans` — the bar is on every route, including ones with no chrome

`vi.mock` factories hoist above every import, so the bar stand-in uses an **async
factory** to reach the real `useRecording`. `require` is not available; this runs
as ESM.

### Verified at the end of the phase

`npm run typecheck` clean · `npm run lint` clean (same two pre-existing warnings)
· `npx vitest run` 120 files, 2267 tests, all passing · `npm run build`
succeeds.
