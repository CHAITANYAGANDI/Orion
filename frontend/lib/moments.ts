/**
 * Marking a transcript: capturing a selection, and finding it again later.
 *
 * Two problems live here, and the second is the one that bites.
 *
 * CAPTURE. A browser selection is a pair of offsets into text nodes, which is
 * not something we can store — the transcript is rendered as one span per word
 * so that any word is clickable, so those offsets describe the DOM, not the
 * transcript. Instead the word spans carry the segment and character offsets
 * they came from, and a selection is read as "which word spans does it touch".
 * That also snaps every mark to whole words, which is what you want: a
 * highlight starting mid-word looks like a rendering bug, and a partial word is
 * a much worse anchor than a whole one.
 *
 * RECOVERY. Orion lets people correct transcript lines. Fixing a typo near
 * the start of a sentence shifts every character offset after it — so an
 * annotation stored as offsets alone does not break loudly, it silently slides
 * onto different words. `resolveRange` therefore trusts the offsets only when
 * the text still standing there is the text that was selected, falls back to
 * searching for the quoted words, and returns null rather than guessing. A mark
 * that cannot be placed is reported as such instead of drawn somewhere wrong.
 */

import type { MomentKind, MomentRange, SpokenWord, TranscriptMoment } from "@/lib/types";
import { timecode } from "@/lib/format";

/** One rendered word: where it sits in the text, and when it was said. */
export interface Token {
  /** What to draw. Includes the whitespace up to the next word, so joining the
   *  tokens reproduces the utterance exactly. */
  text: string;
  /** Character offsets of the word itself, excluding that trailing whitespace. */
  from: number;
  to: number;
  start: number;
  end: number;
}

/**
 * Split an utterance into clickable, markable words.
 *
 * Character offsets are the point. A stored highlight is `text.slice(from, to)`
 * on the segment, so the offsets a token reports and the text a selection
 * produces have to be two views of the same string — otherwise a highlight
 * saves and then fails to resolve, which looks exactly like losing it.
 *
 * That is why each token renders the gap that follows it rather than a
 * normalising single space: an utterance containing a double space would
 * otherwise be quoted with one, and neither the offsets nor a search for the
 * quote would find it again.
 *
 * Uses the provider's real per-word timings when the transcript has them (V13).
 * Failing that it estimates, spreading the utterance's span across its words in
 * proportion to their length — which assumes speech has no pauses, so it runs
 * ahead of the voice. Only transcripts recorded before word timings were
 * persisted take that path.
 */
export function tokenize(
  text: string,
  start: number,
  end: number,
  words?: SpokenWord[],
): Token[] {
  const spans: { from: number; to: number; start: number; end: number }[] = [];

  if (words && words.length > 0) {
    // The provider's word list and the segment's text are two renderings of the
    // same speech and are not guaranteed to agree character for character, so
    // each word is *located* in the text rather than assumed to sit at a
    // running offset.
    let cursor = 0;
    for (const w of words) {
      const found = text.indexOf(w.text, cursor);
      const from = found >= 0 ? found : cursor;
      const to = Math.min(text.length, from + w.text.length);
      spans.push({ from, to, start: w.start, end: w.end });
      cursor = to;
    }
  } else {
    const raw = text.match(/\S+\s*/g) ?? [];
    const chars = raw.reduce((n, t) => n + t.length, 0) || 1;
    const span = Math.max(end - start, 0.001);
    let acc = 0;
    for (const token of raw) {
      const trailing = token.length - token.trimEnd().length;
      spans.push({
        from: acc,
        to: acc + token.length - trailing,
        start: start + (acc / chars) * span,
        end: start + ((acc + token.length) / chars) * span,
      });
      acc += token.length;
    }
  }

  return spans.map((s, i) => ({
    // Up to where the next word begins — or, for the last one, the rest of the
    // line, so trailing punctuation and whitespace are never dropped.
    text: i + 1 < spans.length ? text.slice(s.from, spans[i + 1].from) : text.slice(s.from),
    from: s.from,
    to: s.to,
    start: s.start,
    end: s.end,
  }));
}

/** One rendered word, as the transcript tags it in the DOM. */
export interface WordRef {
  segmentId: string;
  /** Character offsets into the segment's own text. */
  from: number;
  to: number;
  text: string;
  start: number;
  end: number;
  speaker: string;
}

/**
 * Which words a character range covers, as positions in the segment's own
 * `words` array.
 *
 * The speaker-correction call addresses words by position, because that is what
 * the server can split on -- a character offset has no matching point in the
 * audio. The mapping goes through `tokenize`, which is also what rendered the
 * words the user selected, so the positions returned here are the same ones the
 * reader was pointing at. Doing the arithmetic separately would be a second
 * implementation of word boundaries, and the two would disagree on exactly the
 * punctuation-heavy line somebody is trying to fix.
 *
 * Returns null when the segment has no per-word timings. Those cannot be split
 * at all, and saying so is the caller's job.
 */
export function wordRangeFor(
  segment: { text: string; start: number; end: number; words?: SpokenWord[] | null },
  startOffset: number,
  endOffset: number,
): { fromWord: number; toWord: number } | null {
  if (!segment.words || segment.words.length === 0) return null;
  // A caret is not a selection. Without this a zero-width range still matches
  // whichever word it sits inside, so a stray click would offer to reattribute
  // a word the user never selected.
  if (endOffset <= startOffset) return null;

  const tokens = tokenize(segment.text, segment.start, segment.end, segment.words);
  let first = -1;
  let last = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    // Touching, not containing: a selection that clips the first character of a
    // word still means that word. Requiring containment would silently drop the
    // edges of every drag a person actually makes.
    if (tokens[i].to > startOffset && tokens[i].from < endOffset) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  return { fromWord: first, toWord: last };
}

export interface SelectionCapture {
  ranges: MomentRange[];
  quote: string;
  speaker: string;
  startSeconds: number;
  endSeconds: number;
}

/**
 * Group the touched words into one range per segment.
 *
 * Per segment rather than one range overall because a selection routinely
 * crosses an utterance boundary — diarization splits on pauses, not on
 * sentences, so a single spoken sentence often arrives as two segments — and a
 * range that spanned them would have offsets into two different strings.
 *
 * Words are expected in document order. A segment that appears, is interrupted
 * and reappears is folded into one range spanning the gap: that only happens
 * when the transcript is rendered out of order, and one range with a slightly
 * wide span beats two overlapping ones.
 */
export function rangesFromWords(words: WordRef[]): SelectionCapture | null {
  if (words.length === 0) return null;

  const bySegment = new Map<string, WordRef[]>();
  for (const w of words) {
    const list = bySegment.get(w.segmentId);
    if (list) list.push(w);
    else bySegment.set(w.segmentId, [w]);
  }

  const ranges: MomentRange[] = [];
  const quotes: string[] = [];
  for (const [segmentId, group] of bySegment) {
    const quote = group
      .map((w) => w.text)
      .join("")
      .trim();
    if (!quote) continue;
    ranges.push({
      segmentId,
      startOffset: Math.min(...group.map((w) => w.from)),
      endOffset: Math.max(...group.map((w) => w.to)),
      quote,
    });
    quotes.push(quote);
  }
  if (ranges.length === 0) return null;

  return {
    ranges,
    quote: quotes.join(" "),
    // The first speaker in the selection. A selection spanning a handover has
    // two, and naming the one it starts with is both truthful and stable —
    // whereas "Priya and Marcus" would need re-deriving every time the moment
    // is displayed.
    speaker: words[0].speaker,
    startSeconds: Math.min(...words.map((w) => w.start)),
    endSeconds: Math.max(...words.map((w) => w.end)),
  };
}

/**
 * Attributes the transcript stamps on the DOM so a selection can be read back.
 *
 * The segment and speaker sit on the utterance that wraps the words, not on
 * each word: an hour of speech is tens of thousands of spans, and repeating the
 * speaker's name on every one of them is a measurable amount of document for no
 * information that `closest()` cannot recover.
 */
export const WORD_ATTR = "data-word";
export const SEG_ATTR = "data-seg";

function wordRef(el: Element): WordRef | null {
  const holder = el.closest(`[${SEG_ATTR}]`);
  const segmentId = holder?.getAttribute(SEG_ATTR);
  if (!holder || !segmentId) return null;
  const num = (name: string) => Number(el.getAttribute(name));
  return {
    segmentId,
    from: num("data-from"),
    to: num("data-to"),
    text: el.textContent ?? "",
    start: num("data-start"),
    end: num("data-end"),
    speaker: holder.getAttribute("data-speaker") ?? "",
  };
}

/**
 * Read the current selection, if it lies inside `root`.
 *
 * Kept deliberately thin: everything except "which spans are touched" is in
 * {@link rangesFromWords}, which is where the tests are. The DOM Selection API
 * is barely implemented in jsdom, and the logic worth testing must not be
 * trapped behind it.
 */
export function readSelection(root: HTMLElement | null): SelectionCapture | null {
  if (!root || typeof window === "undefined") return null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  // Search the selection's own subtree rather than the whole transcript. An
  // hour of speech is tens of thousands of word spans and every one of them
  // would be tested; the common ancestor of a selection is almost always a
  // single turn.
  const container = range.commonAncestorContainer;
  const scope =
    (container.nodeType === Node.ELEMENT_NODE
      ? (container as Element)
      : container.parentElement) ?? root;

  // A selection inside a single word has that word as its scope, and an element
  // is not returned by its own querySelectorAll — so the obvious version finds
  // nothing for the most precise selection a user can make.
  const inWord = scope.closest(`[${WORD_ATTR}]`);
  const candidates = inWord
    ? [inWord]
    : Array.from(scope.querySelectorAll(`[${WORD_ATTR}]`));

  const touched: WordRef[] = [];
  for (const el of candidates) {
    if (!range.intersectsNode(el)) continue;
    const ref = wordRef(el);
    if (ref) touched.push(ref);
  }
  return rangesFromWords(touched);
}

/**
 * Where a stored range sits in the segment's text *now*.
 *
 * Tried in order:
 *   1. the offsets, accepted only if the text there is still the text that was
 *      selected — the fast path, and the only one that is certain
 *   2. the quoted words, searched for, preferring the occurrence nearest to
 *      where they used to be, so a repeated phrase does not jump across the
 *      sentence after an unrelated edit
 *   3. nothing — the words were rewritten or deleted
 *
 * Returning null is a real outcome, not a bug: the caller reports the mark as
 * unplaceable rather than drawing it over words that were never selected.
 */
export function resolveRange(
  segmentText: string,
  range: MomentRange,
): { start: number; end: number } | null {
  const quote = range.quote ?? "";

  if (!quote) {
    // Nothing to verify against, so the offsets are all there is. Accepted only
    // while they are in bounds and non-empty.
    const inBounds =
      range.startOffset >= 0 &&
      range.endOffset > range.startOffset &&
      range.endOffset <= segmentText.length;
    return inBounds ? { start: range.startOffset, end: range.endOffset } : null;
  }

  if (segmentText.slice(range.startOffset, range.endOffset) === quote) {
    return { start: range.startOffset, end: range.endOffset };
  }

  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = segmentText.indexOf(quote); i >= 0; i = segmentText.indexOf(quote, i + 1)) {
    const distance = Math.abs(i - range.startOffset);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best >= 0 ? { start: best, end: best + quote.length } : null;
}

/** A resolved mark on one segment, ready to paint. */
export interface SegmentMark {
  start: number;
  end: number;
  moment: TranscriptMoment;
}

/**
 * The marks to paint on one segment, resolved against its current text.
 *
 * Bookmarks are excluded: they mark a time rather than a passage, so there is
 * nothing to draw over the words.
 */
export function segmentMarks(
  segmentId: string,
  segmentText: string,
  moments: TranscriptMoment[],
): SegmentMark[] {
  const marks: SegmentMark[] = [];
  for (const moment of moments) {
    if (moment.kind === "BOOKMARK") continue;
    for (const range of moment.ranges) {
      if (range.segmentId !== segmentId) continue;
      const at = resolveRange(segmentText, range);
      if (at) marks.push({ start: at.start, end: at.end, moment });
    }
  }
  return marks.sort((a, b) => a.start - b.start);
}

/** True when a word's span is touched by a mark. */
export function isMarked(marks: SegmentMark[], from: number, to: number): SegmentMark | undefined {
  // Overlap rather than containment: a mark repaired by quote-search can land
  // a character off a word boundary when the surrounding text changed width.
  return marks.find((m) => from < m.end && to > m.start);
}

/**
 * True when a passage-shaped moment can no longer be placed on the transcript.
 *
 * The list shows these with their quote and timestamp and says so, which is the
 * honest outcome after somebody rewrote the line it was attached to. Silently
 * dropping them would look like the app had lost the mark.
 */
export function isOrphaned(
  moment: TranscriptMoment,
  segmentText: (segmentId: string) => string | undefined,
): boolean {
  if (moment.kind === "BOOKMARK" || moment.ranges.length === 0) return false;
  return !moment.ranges.some((r) => {
    const text = segmentText(r.segmentId);
    return text !== undefined && resolveRange(text, r) !== null;
  });
}

/** `Priya (12:34): "the quoted words"` — the shape used on the clipboard. */
export function attributedQuote(m: {
  speaker?: string;
  startSeconds: number;
  quote: string;
}): string {
  const who = m.speaker?.trim() || "Unknown speaker";
  return `${who} (${timecode(m.startSeconds)}): “${m.quote.trim()}”`;
}

/**
 * The chat accepts 2000 characters. A selection can be longer, and a prompt
 * rejected by validation would read as a menu item that does nothing — so the
 * quote is trimmed to leave room for the wrapper text.
 */
const MAX_PROMPT_QUOTE = 1500;

function clip(quote: string): string {
  const q = quote.trim();
  return q.length <= MAX_PROMPT_QUOTE ? q : `${q.slice(0, MAX_PROMPT_QUOTE).trimEnd()}…`;
}

/**
 * The opening of a question about a passage.
 *
 * Left unfinished on purpose — it goes into the input box for the user to
 * complete, rather than being sent. "Ask about this" with no question is the
 * one case where the app cannot guess what is being asked.
 */
export function askPrefix(quote: string): string {
  return `About this passage: “${clip(quote)}”\n\n`;
}

/** Complete, so it sends on click. */
export function summarizePrompt(quote: string): string {
  return `Summarize this passage in two or three sentences: “${clip(quote)}”`;
}

/** The label a kind gets in the list, singular. */
export const KIND_LABEL: Record<MomentKind, string> = {
  HIGHLIGHT: "Highlight",
  BOOKMARK: "Bookmark",
  NOTE: "Note",
  REACTION: "Reaction",
};
