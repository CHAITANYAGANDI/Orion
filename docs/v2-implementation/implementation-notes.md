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
