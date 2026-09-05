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
