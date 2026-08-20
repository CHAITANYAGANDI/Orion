/**
 * Turning a stream of revisions into a transcript that reads like one.
 *
 * Streaming speech recognition does not emit sentences, it emits opinions. The
 * same turn arrives repeatedly, longer and more confident each time:
 *
 *     turn 7, partial:  "We need to deploy"
 *     turn 7, partial:  "We need to deploy Friday"
 *     turn 7, final:    "We need to deploy Friday."
 *
 * Appended, that is three lines about one sentence and the meeting becomes
 * unreadable within a minute. What belongs on screen is one line that grows.
 * So every message is an **upsert keyed on the provider's own turn order**,
 * never a push.
 *
 * Kept as pure functions over plain arrays, apart from the websocket and apart
 * from React, because this is the part with the interesting failure modes —
 * reconnection, revision, mid-turn speaker changes — and none of them are worth
 * reproducing with a live socket to test.
 *
 * ## Reconnection is why the key is not just the turn order
 *
 * A dropped websocket is reopened as a **new session**, and a new session
 * counts turns from zero and timestamps from zero. Keyed on turn order alone,
 * the first turn after a reconnect would overwrite the first turn of the
 * meeting; timed on provider time alone, it would claim to have been said at
 * 00:00. Both are fixed by the same thing: a session carries an epoch that
 * scopes its keys and an offset that places its clock on the recording's
 * timeline.
 *
 * ## Why one provider turn can become several lines
 *
 * The provider attributes **every word**, not just the turn. Most of the time
 * the words agree with each other and one turn is one line. When they do not,
 * that disagreement is a speaker change inside the turn — someone saying
 * "Exactly." in the middle of a colleague's paragraph — and it was previously
 * unrepresentable: the turn carried a single `speaker`, so the interjection was
 * absorbed into whoever was talking around it. A turn is therefore a *family*
 * of lines here, `${epoch}:${order}:${run}`, and a revision replaces the whole
 * family rather than editing one line, which is what keeps the words from being
 * duplicated when the provider changes its mind about where the boundary was.
 */

import {
  CanonicalSpeakers,
  UNATTRIBUTED,
  UNKNOWN_SPEAKER,
  rawToken,
  type Attribution,
  type SpeakerIdentity,
} from "@/lib/canonical-speakers";

export { UNKNOWN_SPEAKER } from "@/lib/canonical-speakers";
export type { Attribution } from "@/lib/canonical-speakers";

export interface LiveTurn {
  /** Session epoch, provider turn order, and which run within that turn. */
  id: string;
  /** The `${epoch}:${order}` family this line belongs to. */
  turnKey: string;
  /** Seconds into the *recording*, not into the session. */
  at: number;
  speaker: string;
  /** Meeting-local identity, stable across relabelling. Null when unknown. */
  speakerKey: string | null;
  /** The provider's own cluster id. Kept for reconciliation, never displayed. */
  speakerRaw: string | null;
  speakerStatus: Attribution;
  text: string;
  /** False while the provider may still change its mind about the words. */
  final: boolean;
}

/**
 * Where one streaming session sits on the recording's timeline.
 *
 * `epoch` increments per connection; `offsetSeconds` is how much of the
 * recording had already happened when it opened. After a reconnect the
 * provider's clock restarts and this is what keeps the transcript aligned with
 * the audio file the words will eventually be matched against.
 */
export interface SessionContext {
  epoch: number;
  offsetSeconds: number;
}

/* -------------------------------------------------------------------------- */
/* The provider's messages, as far as this cares about them.                  */
/* -------------------------------------------------------------------------- */

export interface TurnWord {
  text?: string;
  /** Milliseconds from the start of the session. */
  start?: number;
  end?: number;
  confidence?: number;
  word_is_final?: boolean;
  speaker?: string | number | null;
}

export interface TurnMessage {
  type?: string;
  turn_order?: number;
  end_of_turn?: boolean;
  turn_is_formatted?: boolean;
  transcript?: string;
  words?: TurnWord[];
  speaker_label?: string | number | null;
  audio_start?: number;
}

export interface SpeakerRevisionMessage {
  type?: string;
  /**
   * The wire field, confirmed against a live session.
   *
   * This is the fix for the interjection bug on the live path. The provider
   * sends `{ type: "SpeakerRevision", revisions: [...] }`; this file read
   * `message.turns`, which is never present, so **every speaker revision was
   * silently discarded**. A turn the provider had not yet clustered arrived
   * labelled `PENDING` and stayed that way, even though the correction naming
   * it Speaker 2 turned up moments later.
   */
  revisions?: SpeakerRevision[];
  /** Tolerated alias. Harmless, and cheap insurance against the field moving. */
  turns?: SpeakerRevision[];
}

export interface SpeakerRevision {
  turn_order?: number;
  speaker_label?: string | number | null;
  /** Present on real revisions, and re-splits the turn when it disagrees. */
  words?: TurnWord[];
}

/* -------------------------------------------------------------------------- */

/**
 * When this turn began, in seconds into the recording.
 *
 * From the provider, never from a timer in this tab. The old browser preview
 * stamped each phrase with Recallix's own elapsed counter at the moment
 * recognition happened to return, which is a description of how long
 * recognition took — that is how a line spoken at 0:04 came to be labelled
 * 0:10. The provider knows when the audio it transcribed arrived.
 */
export function turnStartSeconds(message: TurnMessage, session: SessionContext): number {
  const firstWord = (message.words ?? []).find((w) => typeof w.start === "number");
  const ms =
    typeof message.audio_start === "number" ? message.audio_start : firstWord?.start;
  return atSeconds(ms, session);
}

function atSeconds(ms: number | undefined, session: SessionContext): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    // Nothing usable. The session offset alone is still better than zero: it
    // puts the line at the reconnect rather than at the start of the meeting.
    return session.offsetSeconds;
  }
  return session.offsetSeconds + ms / 1000;
}

function familyKey(order: number, session: SessionContext): string {
  return `${session.epoch}:${order}`;
}

/**
 * Break a turn's words wherever the provider changes its attribution.
 *
 *     A A A A B A A A   ->   [A…], [B], [A…]
 *
 * The one-word B run in the middle is the entire point. It is a real turn and
 * merging it into either neighbour puts words in somebody's mouth. Nothing here
 * splits on anything but an explicit change of provider label — not on a pause,
 * not on punctuation, not on how short the text is. A word the provider left
 * unattributed continues the run it is in rather than starting an island of its
 * own, because gaps mid-utterance are common and honouring each one would
 * shred a sentence into alternating known and unknown fragments.
 */
function runsOf(
  words: TurnWord[],
  /**
   * Who a word belongs to when the provider did not say.
   *
   * The turn's own label, or failing that the first word in the turn that does
   * carry one. Without it a turn whose opening words are unattributed opens
   * with an "Unknown speaker" fragment before naming the person who said the
   * rest of the same sentence, which is a worse answer than the one the turn
   * already contains.
   */
  fallback: string | null = null,
): { token: string | null; words: TurnWord[] }[] {
  const runs: { token: string | null; words: TurnWord[] }[] = [];
  for (const word of words) {
    if (!String(word.text ?? "").trim()) continue;
    const token = rawToken(word.speaker) ?? fallback;
    const current = runs[runs.length - 1];
    if (current && (token === null || token === current.token)) {
      current.words.push(word);
      continue;
    }
    runs.push({ token, words: [word] });
  }
  return runs;
}

/**
 * Render words as a line without mangling the provider's punctuation.
 *
 * The provider attaches punctuation to the word it belongs to ("Exactly.",
 * "Yes,"), so a plain join is almost always right. The exception is a token
 * that is *only* punctuation, which a plain join would push out to its own
 * island — "Let's ship Friday , if QA passes".
 *
 * `capitalise` is for a fragment that begins mid-sentence because the words
 * before it turned out to belong to someone else; left lowercase it reads as a
 * broken sentence rather than as a turn. Skipped where the first word has an
 * interior capital, so "iPhone" does not become "IPhone".
 */
export function joinWords(words: TurnWord[], capitalise = false): string {
  let out = "";
  for (const word of words) {
    const text = String(word.text ?? "").trim();
    if (!text) continue;
    if (out && !isTrailingPunctuation(text)) out += " ";
    out += text;
  }
  if (!capitalise || !out) return out;
  const first = out[0];
  if (!/[a-z]/.test(first)) return out;
  const head = out.split(" ", 1)[0];
  if (/[A-Z]/.test(head.slice(1))) return out;
  return first.toUpperCase() + out.slice(1);
}

function isTrailingPunctuation(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text) && ",.;:!?)]}'\"…%".includes(text[0]);
}

/**
 * Fold one Turn message into the transcript.
 *
 * Returns the same array reference when nothing changed, so React can skip the
 * render — a partial that repeats the text it already had arrives often, and
 * re-rendering a long transcript for each one is most of the cost of running
 * this at all.
 *
 * `speakers` is mutated: it is the session's speaker registry, and a number it
 * hands out is fixed for the rest of the meeting.
 */
export function applyTurn(
  turns: LiveTurn[],
  message: TurnMessage,
  session: SessionContext,
  speakers: CanonicalSpeakers,
): LiveTurn[] {
  const order = message.turn_order;
  if (typeof order !== "number" || !Number.isFinite(order)) return turns;

  const text = (message.transcript ?? "").trim();
  if (!text) {
    // An empty partial is the provider clearing its throat, not a retraction.
    // Dropping the text would blank a line and put it back a moment later.
    return turns;
  }

  const key = familyKey(order, session);
  const existing = turns.filter((t) => t.turnKey === key);

  // Once final, later partials for the same turn are ignored. Out-of-order
  // delivery is rare and this is what it costs to be right about it.
  if (existing.some((t) => t.final) && !message.end_of_turn) return turns;

  const replacements = linesFor({
    key,
    text,
    words: message.words ?? [],
    turnLabel: message.speaker_label,
    start: turnStartSeconds(message, session),
    final: message.end_of_turn === true,
    session,
    speakers,
  });

  // A turn keeps the moment it began, however much it grows afterwards. The
  // provider's `audio_start` advances as a turn is revised, and following it
  // would slide the line forward while somebody is reading it — a timestamp
  // drifting away from the audio it points at. Only the first line inherits:
  // any others were split out and have real word timings of their own.
  if (existing.length > 0 && replacements.length > 0) {
    replacements[0] = { ...replacements[0], at: existing[0].at };
  }

  return merge(turns, key, replacements, existing);
}

/**
 * One provider turn, as the one or several lines it actually contains.
 *
 * A turn whose words agree keeps the provider's own `transcript` verbatim —
 * it is better formatted than anything rebuilt from the word list, and rebuilt
 * text is what makes a live transcript look subtly worse than the final one.
 * Only a turn that has to be split gets its text reassembled.
 */
function linesFor({
  key,
  text,
  words,
  turnLabel,
  start,
  final,
  session,
  speakers,
}: {
  key: string;
  text: string;
  words: TurnWord[];
  turnLabel: string | number | null | undefined;
  start: number;
  final: boolean;
  session: SessionContext;
  speakers: CanonicalSpeakers;
}): LiveTurn[] {
  // The turn's own label first; the words are the fallback for the partials
  // that carry no turn-level label yet.
  const fallback = rawToken(turnLabel) ?? firstWordToken(words);
  const runs = runsOf(words, fallback);

  if (runs.length <= 1) {
    return [line(key, 0, speakers.forToken(runs[0]?.token ?? fallback), start, text, final)];
  }

  return runs.map((run, index) =>
    line(
      key,
      index,
      speakers.forToken(run.token),
      atSeconds(run.words.find((w) => typeof w.start === "number")?.start, session),
      joinWords(run.words, index > 0),
      final,
    ),
  );
}

function firstWordToken(words: TurnWord[]): string | null {
  for (const word of words) {
    const token = rawToken(word.speaker);
    if (token !== null) return token;
  }
  return null;
}

function line(
  key: string,
  index: number,
  identity: SpeakerIdentity,
  at: number,
  text: string,
  final: boolean,
): LiveTurn {
  return {
    id: `${key}:${index}`,
    turnKey: key,
    at,
    speaker: identity.label,
    speakerKey: identity.key,
    speakerRaw: identity.raw,
    speakerStatus: identity.status,
    text,
    final,
  };
}

/**
 * Swap a turn's lines for its new ones, in place.
 *
 * Replacing the family rather than appending is what stops a re-split from
 * duplicating text: when "We should ship Friday exactly." becomes two lines,
 * the single line it came from has to go, and matching on the family key is
 * what finds it.
 */
function merge(
  turns: LiveTurn[],
  key: string,
  replacements: LiveTurn[],
  existing: LiveTurn[],
): LiveTurn[] {
  if (existing.length === replacements.length && existing.every((t, i) => same(t, replacements[i]))) {
    return turns;
  }
  const out = turns.filter((t) => t.turnKey !== key).concat(replacements);
  // Sorted by when it was said, not by when it arrived. Within a session those
  // agree; across a reconnect they do not.
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

function same(a: LiveTurn, b: LiveTurn): boolean {
  return (
    a.id === b.id &&
    a.text === b.text &&
    a.final === b.final &&
    a.speaker === b.speaker &&
    a.at === b.at
  );
}

/**
 * Apply the provider's second thoughts about who was speaking.
 *
 * Diarization improves as a session goes on — two voices that were
 * indistinguishable in the first ten seconds separate cleanly by the first
 * minute — so the provider revises earlier labels, and a turn it could not
 * place at all arrives labelled `PENDING` and is named later. Applying those
 * revisions is the difference between a live transcript that converges on the
 * final one and one that drifts away from it.
 *
 * A revision may carry words, and those words may disagree with each other, in
 * which case the turn is re-split rather than relabelled — the correction the
 * provider is sending is "that was two people", and only re-splitting can say
 * so. The words are otherwise not revisited: a finalised turn's text is
 * settled, and rewriting it under somebody's eyes would undo the one property
 * that makes the finalised part readable.
 */
export function applySpeakerRevision(
  turns: LiveTurn[],
  message: SpeakerRevisionMessage,
  session: SessionContext,
  speakers: CanonicalSpeakers,
): LiveTurn[] {
  const revisions = message.revisions ?? message.turns ?? [];
  if (revisions.length === 0) return turns;

  let out = turns;
  for (const revision of revisions) {
    if (typeof revision.turn_order !== "number") continue;
    const key = familyKey(revision.turn_order, session);
    const existing = out.filter((t) => t.turnKey === key);
    if (existing.length === 0) continue;

    const revisionFallback =
      rawToken(revision.speaker_label) ?? firstWordToken(revision.words ?? []);
    const runs = runsOf(revision.words ?? [], revisionFallback);
    const replacements =
      runs.length > 1
        ? runs.map((run, index) =>
            line(
              key,
              index,
              speakers.forToken(run.token),
              atSeconds(run.words.find((w) => typeof w.start === "number")?.start, session),
              joinWords(run.words, index > 0),
              existing[0].final,
            ),
          )
        : relabelled(existing, speakers.forToken(revisionFallback));

    if (replacements === existing) continue;
    out = merge(out, key, replacements, existing);
  }
  return out;
}

/**
 * The same lines under a new name.
 *
 * A revision that would *remove* attribution is ignored. Going from "Speaker 2"
 * back to "Unknown speaker" mid-meeting is a line flickering between two
 * answers, and the earlier one was at least an answer.
 */
function relabelled(existing: LiveTurn[], identity: SpeakerIdentity): LiveTurn[] {
  if (identity === UNATTRIBUTED && existing.some((t) => t.speakerStatus === "attributed")) {
    return existing;
  }
  if (existing.every((t) => t.speaker === identity.label)) return existing;
  return existing.map((t) => ({
    ...t,
    speaker: identity.label,
    speakerKey: identity.key,
    speakerRaw: identity.raw,
    speakerStatus: identity.status,
  }));
}

/** The settled part of the transcript — what a caller should trust. */
export function finalTurns(turns: LiveTurn[]): LiveTurn[] {
  return turns.filter((t) => t.final);
}

/** The one turn still being spoken, if any. */
export function pendingTurn(turns: LiveTurn[]): LiveTurn | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (!turns[i].final) return turns[i];
  }
  return null;
}
