"use client";

/**
 * What is left of the account's allowance, and what that permits.
 *
 * <p>100 transcribed minutes and 3 imports, for the life of the account. When
 * either runs out it is out: there is no reset date, no upgrade and nothing to
 * buy, so a refusal here is final rather than an invitation.
 *
 * <p><b>Why this exists in front of the server rather than only behind it.</b>
 * {@code UsageLimitService} is the authority and refuses at the moment a meeting
 * is created — which for a recording is the moment it is <em>saved</em>, after
 * somebody has already sat through the meeting. A server-only limit therefore
 * has exactly one way to enforce itself against a recording: destroy it. This
 * module is what stops the situation arising, by refusing to start a recording
 * that cannot fit and by stopping one that reaches the edge. The server stays
 * strict; it simply never has to be the one to say no.
 *
 * <p><b>Fail closed.</b> If the allowance cannot be read, recording is refused
 * rather than allowed. That is the opposite of the usual instinct and it is
 * deliberate: the alternative is starting an hour-long recording blind and
 * having the server refuse it at save time, which loses the meeting. A minute
 * of "we could not check your balance" is recoverable; an unsaveable recording
 * is not.
 */

import { useGetUsageQuery } from "@/lib/api";

export interface Allowance {
  /** Still resolving. Nothing should be started on the strength of this. */
  loading: boolean;
  /** The balance could not be read at all. Treated as no balance. */
  unknown: boolean;
  minutesLeft: number;
  importsLeft: number;
  /** Whole seconds a new recording may run for. */
  secondsLeft: number;
  /** There are minutes left to spend. */
  canRecord: boolean;
  /** There are minutes left *and* an import slot. */
  canImport: boolean;
}

/**
 * A limit of `-1` is the server's unlimited and survives here as one.
 *
 * <p>No plan carries it any more — the allowance is one pair of numbers for
 * every account — but the field still means what it always meant, and an
 * account row left by an earlier build would otherwise read as `used - (-1)`
 * minutes left, which is a negative balance and a permanent refusal.
 */
function remaining(used: number, limit: number): number {
  if (limit < 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, limit - used);
}

export function useAllowance(): Allowance {
  const { data, isLoading, isError } = useGetUsageQuery();

  if (isLoading) {
    return {
      loading: true,
      unknown: false,
      minutesLeft: 0,
      importsLeft: 0,
      secondsLeft: 0,
      canRecord: false,
      canImport: false,
    };
  }

  if (isError || !data) {
    return {
      loading: false,
      unknown: true,
      minutesLeft: 0,
      importsLeft: 0,
      secondsLeft: 0,
      canRecord: false,
      canImport: false,
    };
  }

  const minutesLeft = remaining(data.minutesUsed, data.minutesLimit);
  const importsLeft = remaining(data.importsUsed, data.importsLimit);

  return {
    loading: false,
    unknown: false,
    minutesLeft,
    importsLeft,
    // Infinity * 60 is Infinity, which is what an uncapped account should get.
    secondsLeft: minutesLeft * 60,
    canRecord: minutesLeft > 0,
    canImport: minutesLeft > 0 && importsLeft > 0,
  };
}

/**
 * Why recording is refused, or null when it is not.
 *
 * <p>One sentence, and it never mentions upgrading, because there is nothing to
 * upgrade to. Somebody out of minutes still has every meeting they have already
 * recorded, and the sentence says so rather than reading as the account being
 * closed.
 */
export function recordRefusal(a: Allowance): string | null {
  if (a.loading) return "Checking what is left of your allowance…";
  if (a.unknown) return "Recallix could not check your remaining minutes, so it will not start a recording it might not be able to save. Try again in a moment.";
  if (a.minutesLeft <= 0) {
    return "You have used all 100 transcription minutes on this account. Everything already transcribed is still here, but there are no minutes left to record with.";
  }
  return null;
}

/** Why importing is refused, or null when it is not. */
export function importRefusal(a: Allowance): string | null {
  if (a.loading) return null;
  if (a.unknown) return null;
  if (a.minutesLeft <= 0) {
    return "You have used all 100 transcription minutes on this account, so there is nothing left to transcribe an import with.";
  }
  if (a.importsLeft <= 0) {
    return "You have used all 3 imports on this account.";
  }
  return null;
}

/**
 * Why AI Chat is closed, or null when it is not.
 *
 * <p>Chat spends no transcription minutes — it spends context and a completion
 * — so on the arithmetic it could answer forever on an account that can no
 * longer record. It does not, and the reason is what the allowance is *for*
 * rather than what it counts: 100 minutes is the whole of what an account gets,
 * and an AI feature still running afterwards would make it a limit on recording
 * rather than on the product.
 *
 * <p>Silent while the balance is loading or unreadable. Unlike recording there
 * is nothing irreversible to protect here — the server refuses on its own, and
 * greying the box out over a failed request would close a working feature.
 */
export function chatRefusal(a: Allowance): string | null {
  if (a.loading || a.unknown) return null;
  if (a.minutesLeft <= 0) {
    return "You have used all 100 transcription minutes on this account, so AI Chat is closed. Your meetings and the answers you already have are still here.";
  }
  return null;
}

/**
 * Whether a file of this length fits, and what to say if it does not.
 *
 * <p>Checked before the upload rather than after it. The file is on the user's
 * disk and nothing is lost by saying no — but a great deal of their time is
 * lost by transferring six hundred megabytes first and refusing afterwards.
 *
 * <p>Rounded up to match {@code UsageLimitService}: a 61-second clip spends two
 * minutes, because the alternative is a file that fits by arithmetic and does
 * not fit by the time it has been transcribed. The two must agree, or this
 * permits an upload the server then rejects.
 */
export function lengthRefusal(a: Allowance, durationSeconds: number | null): string | null {
  if (durationSeconds == null || durationSeconds <= 0) return null;
  if (!Number.isFinite(a.minutesLeft)) return null;
  const wanted = Math.ceil(durationSeconds / 60);
  if (wanted <= a.minutesLeft) return null;
  return `That file is ${wanted} minutes and you have ${a.minutesLeft} left of your 100.`;
}
