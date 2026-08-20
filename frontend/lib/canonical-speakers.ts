/**
 * Provider cluster ids in, meeting-local speaker numbers out.
 *
 * AssemblyAI names voices "A", "B", "C"… Recallix used to render those by
 * alphabet position — `charCodeAt(0) - 64` — so a meeting whose two voices
 * clustered as A and D displayed **Speaker 1 and Speaker 4**, with no Speaker 2
 * or 3 anywhere. That reads as two people missing from the room, and it is
 * purely an artefact: which letter a voice lands on is an internal clustering
 * detail, and "D" does not mean "the fourth person".
 *
 * So the letters are translated rather than decoded, by order of first
 * appearance:
 *
 *     provider  A  A  D  D  A  F
 *     canonical 1  1  2  2  1  3
 *
 * The mirror of `ai-service/app/diarization.py`. Two implementations of one
 * rule is a real risk — they can disagree — but the alternative is worse: the
 * live transcript would have to wait for a server round trip to know what to
 * call somebody. They are kept honest by matching test cases on both sides,
 * and by the fact that the final transcript renumbers from scratch anyway, so
 * a live disagreement cannot survive into the saved meeting.
 *
 * ## Once assigned, a number does not move
 *
 * A speaker's number is fixed the first time their voice is heard and holds for
 * the rest of the session. Recomputing it from whatever is currently on screen
 * would be simpler, but a provider revision could then renumber people
 * mid-meeting — and somebody reading along, who has already worked out that
 * Speaker 2 is the person from finance, would watch that come apart.
 */

/** How a speaker label was arrived at. Mirrors the server's `speaker_status`. */
export type Attribution = "attributed" | "unknown";

/** What a turn is called before the provider will commit to who said it. */
export const UNKNOWN_SPEAKER = "Unknown speaker";

/**
 * Tokens that look like a label but are the provider declining to answer.
 *
 * `PENDING` is the live stream's placeholder while clustering catches up. It is
 * on the wire and not in the docs, and it used to fall through to the
 * "it must be a real name" branch — so the transcript showed turns spoken by
 * somebody called **PENDING**, with a matching avatar. Worse than cosmetic: it
 * was marked *attributed*, so it looked like an answer.
 */
const NOT_A_SPEAKER = new Set(["", "UNKNOWN", "UNK", "?", "NONE", "NULL", "PENDING", "SPEAKER"]);

/** One voice, in all three vocabularies that have to coexist. */
export interface SpeakerIdentity {
  /** The provider's own token ("A"), or null where it gave nothing usable. */
  raw: string | null;
  /** Meeting-local and stable across renames: "spk_1". Null when unattributed. */
  key: string | null;
  /** What the transcript shows: "Speaker 2", or UNKNOWN_SPEAKER. */
  label: string;
  status: Attribution;
}

/** The identity for anything the provider would not attribute. */
export const UNATTRIBUTED: SpeakerIdentity = {
  raw: null,
  key: null,
  label: UNKNOWN_SPEAKER,
  status: "unknown",
};

/**
 * The provider's identifier for a voice, or null if there isn't one.
 *
 * Normalising only — deliberately assigns no number. Single letters are cluster
 * ids and are case-folded so "a" and "A" are one voice; anything longer is kept
 * verbatim, because a provider returning a real name from speaker
 * identification is saying something a number cannot.
 */
export function rawToken(value: unknown): string | null {
  if (typeof value === "string") {
    const token = value.trim();
    if (NOT_A_SPEAKER.has(token.toUpperCase())) return null;
    if (!token) return null;
    return token.length === 1 && /[a-z]/i.test(token) ? token.toUpperCase() : token;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * True for a provider cluster id, false for something that is a name.
 *
 * A cluster id ("A", "0") carries no meaning and is replaced by a meeting-local
 * number; anything longer came from speaker identification and is a name, which
 * beats any number Recallix could invent.
 */
export function isGenericCluster(token: string): boolean {
  return token.length === 1 || /^\d+$/.test(token);
}

/**
 * Meeting-local speaker numbering, by order of first appearance.
 *
 * One instance per recording session. Feed it raw provider tokens in the order
 * the words were spoken and it hands back stable identities.
 *
 * An unattributed voice does **not** consume a number: if it did, one
 * unlabelled turn early on would shift every later speaker by one, and the
 * transcript would name people who were never identified.
 */
export class CanonicalSpeakers {
  private readonly byRaw = new Map<string, SpeakerIdentity>();

  /** Identity for a provider label, assigning the next number if it is new. */
  resolve(value: unknown): SpeakerIdentity {
    return this.forToken(rawToken(value));
  }

  /** As `resolve`, for a token already normalised by `rawToken`. */
  forToken(token: string | null): SpeakerIdentity {
    if (token === null) return UNATTRIBUTED;
    const known = this.byRaw.get(token);
    if (known) return known;
    const number = this.byRaw.size + 1;
    const identity: SpeakerIdentity = {
      raw: token,
      key: `spk_${number}`,
      // A real name outranks a generic number. The ordinal is still spent on
      // them, so "Cindy" is spk_1 and the next unnamed voice is Speaker 2
      // rather than colliding with her.
      label: isGenericCluster(token) ? `Speaker ${number}` : token,
      status: "attributed",
    };
    this.byRaw.set(token, identity);
    return identity;
  }

  /** How many distinct voices have been attributed so far. */
  get count(): number {
    return this.byRaw.size;
  }

  /** raw token -> display label, for diagnostics. */
  mapping(): Record<string, string> {
    return Object.fromEntries([...this.byRaw].map(([raw, id]) => [raw, id.label]));
  }
}
