"use client";

/**
 * Record, meaning record.
 *
 * <p>This was a link to a page that asked two questions before opening a
 * microphone. Both are gone: the capture mode had one answer left, and the
 * consent tick — a legal requirement in two-party-consent jurisdictions and
 * under GDPR — was removed on request. It now does the thing it is named after,
 * which is the only defensible reading of a button called Record.
 *
 * <p>One consequence is carried through rather than papered over: nothing is
 * asserted about consent any more, so nothing is claimed about it. See where
 * the meeting is created in components/recording-bar.tsx.
 *
 * <p>A hook rather than a button, because there are two buttons now. The band
 * carries one on a desktop and the bottom tabs carry one on a phone, and they
 * are the same act: the same allowance check, the same route push, the same
 * folder remembered. Two copies of this drift, and the copy that drifts is the
 * one on the phone, which is the harder one to notice.
 */

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useAllowance, recordRefusal } from "@/lib/allowance";
import { recordHref, returnPath } from "@/lib/routes";
import { useRecording, useRecordingSession } from "@/lib/recording-context";

export interface StartRecording {
  /** Push /record and open the microphone, or explain why not. */
  start: () => void;
  /**
   * Why this account cannot record, or null.
   *
   * <p>Not used to disable anything. A dead button explains nothing, and the
   * reason is the whole of what somebody needs here — so the control stays
   * pressable and answers.
   */
  refusal: string | null;
}

/**
 * @param from the pathname the control is being pressed on. A recording started
 *   inside a folder belongs in it, and by the time it is saved — minutes later,
 *   from /record or from wherever the user wandered — there is no folder in the
 *   pathname to read. It is also the way back from a discarded recording.
 */
export function useStartRecording(from: string): StartRecording {
  const recorder = useRecording();
  const session = useRecordingSession();
  const router = useRouter();
  const refusal = recordRefusal(useAllowance());

  function start() {
    // Checked here as well as on /record, because this is where the microphone
    // is actually opened. Navigating first and refusing on arrival would put
    // the browser's permission prompt in front of somebody who is about to be
    // told they cannot record anyway.
    if (refusal) {
      toast.error(refusal);
      return;
    }
    // The route is pushed before the microphone is asked for, so the page is on
    // screen behind the browser's permission prompt and it is obvious what is
    // being asked for and by whom.
    //
    // /record?r=%2Ffolder%2Fprj_1 — the page this was pressed on, on the URL,
    // so that a reload of /record still knows where the recording came from.
    router.push(recordHref(from));
    if (recorder.state !== "idle") return;
    // And in memory, which is what survives navigating away from /record while
    // the meeting runs. Before the navigation lands and before the microphone
    // opens: this is the only moment it is knowable, and it is remembered until
    // the meeting is created. Set every time, so a recording started from Home
    // cannot inherit the last one's folder.
    session.setReturnTo(returnPath(from));
    // Nothing is reported. There was a fire-and-forget POST here whose only
    // purpose was a "Recording started" notification for the account's other
    // devices, and on this device it announced a timer, a waveform and a red
    // Stop button already on screen -- one more row in a bell that had too
    // many. See NotificationKind#retired.
    void recorder.start();
  }

  return { start, refusal };
}
