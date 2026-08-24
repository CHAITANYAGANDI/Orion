import { describe, it, expect } from "vitest";
import {
  recordRefusal,
  importRefusal,
  lengthRefusal,
  aiRefusal,
  spentNote,
  type AiFeature,
  type Allowance,
} from "@/lib/allowance";

/**
 * The gate in front of a limit that has no way back.
 *
 * <p>100 minutes and 3 imports, once. There is no reset date and nothing to
 * buy, so every refusal these produce is permanent — which is why the wording
 * matters as much as the arithmetic and is asserted here.
 *
 * <p>The failure worth guarding hardest is the one that is silent: this and
 * `UsageLimitService` both round a part-minute up, and if they ever disagreed
 * the gate would wave through an upload the server then rejects, after the
 * transfer. A user would see a full progress bar and then a refusal.
 */

function allowance(over: Partial<Allowance> = {}): Allowance {
  const minutesLeft = over.minutesLeft ?? 100;
  return {
    loading: false,
    unknown: false,
    minutesLeft,
    importsLeft: 3,
    secondsLeft: minutesLeft * 60,
    canRecord: minutesLeft > 0,
    canImport: minutesLeft > 0,
    ...over,
  };
}

describe("recording", () => {
  it("is allowed while any minutes remain", () => {
    expect(recordRefusal(allowance({ minutesLeft: 1 }))).toBeNull();
  });

  it("is refused once the minutes are gone", () => {
    expect(recordRefusal(allowance({ minutesLeft: 0 }))).toMatch(/all 100 transcription minutes/);
  });

  it("says what somebody still has, not only what they have lost", () => {
    // A refusal that reads as the account being closed sends somebody looking
    // for their meetings. Everything already transcribed is still there.
    expect(recordRefusal(allowance({ minutesLeft: 0 }))).toMatch(/already transcribed is still here/);
  });

  it("never offers an upgrade, because there is not one", () => {
    const refusal = recordRefusal(allowance({ minutesLeft: 0 })) ?? "";
    expect(refusal).not.toMatch(/upgrade|plan|billing|buy/i);
  });

  it("is refused while the balance is still unknown", () => {
    // Fail closed, and this is the whole reason the module exists. Starting an
    // hour-long recording without knowing the balance risks the server refusing
    // it at save time, which loses the meeting. Refusing to start loses a
    // moment.
    expect(recordRefusal(allowance({ unknown: true, minutesLeft: 0 }))).toMatch(/could not check/);
    expect(recordRefusal(allowance({ loading: true }))).toMatch(/Checking/);
  });
});

describe("importing", () => {
  it("is refused once the three are spent", () => {
    expect(importRefusal(allowance({ importsLeft: 0 }))).toMatch(/all 3 imports/);
  });

  it("is refused when the minutes are gone even with imports to spare", () => {
    // Both allowances have to hold. An import slot buys nothing without the
    // minutes to transcribe what it brings in.
    expect(importRefusal(allowance({ minutesLeft: 0, importsLeft: 3 }))).toMatch(/100 transcription minutes/);
  });

  it("says nothing at all while the balance is loading", () => {
    // Unlike recording. Nothing irreversible happens by opening the dialog, and
    // a refusal that appears for half a second and then vanishes reads as a
    // glitch.
    expect(importRefusal(allowance({ loading: true }))).toBeNull();
  });
});

describe("whether a file fits", () => {
  it("allows one that fits exactly", () => {
    expect(lengthRefusal(allowance({ minutesLeft: 5 }), 300)).toBeNull();
  });

  it("refuses one that does not, and says both numbers", () => {
    expect(lengthRefusal(allowance({ minutesLeft: 5 }), 600)).toBe(
      "That file is 10 minutes and you have 5 left of your 100.",
    );
  });

  it("rounds a part-minute up, exactly as the server does", () => {
    // 61 seconds is two minutes of a one-minute balance. Rounding down here
    // would pass a file the server then refuses, after it has been uploaded.
    expect(lengthRefusal(allowance({ minutesLeft: 1 }), 61)).not.toBeNull();
    expect(lengthRefusal(allowance({ minutesLeft: 1 }), 60)).toBeNull();
  });

  it("says nothing about a file whose length is not known yet", () => {
    // The duration is probed after the file is chosen and can fail. An unknown
    // length is not a refusal — the server takes that case too.
    expect(lengthRefusal(allowance({ minutesLeft: 1 }), null)).toBeNull();
    expect(lengthRefusal(allowance({ minutesLeft: 1 }), 0)).toBeNull();
  });

  it("does not measure against an unlimited balance", () => {
    // -1 is the server's unlimited. No plan carries it now, but a row left by
    // an earlier build would otherwise be refused for every file.
    expect(lengthRefusal(allowance({ minutesLeft: Number.POSITIVE_INFINITY }), 99999)).toBeNull();
  });
});

/**
 * The AI features, and the line the allowance is drawn along.
 *
 * <p>Chat, rewriting a summary, rematching speakers, translating and
 * reprocessing all close when the minutes go. Three of the five spend no
 * transcription minutes at all, so this is a decision about what the allowance
 * *is* rather than what it counts — and the tests are here so that decision has
 * to be made again deliberately rather than eroded one feature at a time.
 *
 * <p>The refusals are also asserted for what they say. These are permanent,
 * there is nothing to buy, and a sentence that only says what stopped working
 * reads as an account that has been closed.
 */
const FEATURES: AiFeature[] = ["chat", "summary", "speakers", "translation", "reprocess"];

describe("the AI features", () => {
  it("are all open while a single minute remains", () => {
    for (const feature of FEATURES) {
      expect(aiRefusal(allowance({ minutesLeft: 1 }), feature)).toBeNull();
    }
    expect(spentNote(allowance({ minutesLeft: 1 }))).toBeNull();
  });

  it("are all closed once the minutes are gone", () => {
    // Listed rather than looped over a runtime value, so adding a sixth feature
    // means adding it here rather than inheriting an exemption.
    for (const feature of FEATURES) {
      expect(aiRefusal(allowance({ minutesLeft: 0 }), feature)).not.toBeNull();
    }
    expect(spentNote(allowance({ minutesLeft: 0 }))).not.toBeNull();
  });

  it("stay open for an account with no ceiling", () => {
    // A limit of -1 is the server's unlimited, and survives here as Infinity.
    for (const feature of FEATURES) {
      expect(aiRefusal(allowance({ minutesLeft: Number.POSITIVE_INFINITY }), feature)).toBeNull();
    }
  });

  it("say nothing while the balance is loading or unreadable", () => {
    // Deliberately unlike recording, which fails closed. There is nothing
    // irreversible to protect here, the server refuses on its own, and greying
    // five features out over one failed request closes a working product.
    for (const feature of FEATURES) {
      expect(aiRefusal(allowance({ loading: true, minutesLeft: 0 }), feature)).toBeNull();
      expect(aiRefusal(allowance({ unknown: true, minutesLeft: 0 }), feature)).toBeNull();
    }
    expect(spentNote(allowance({ loading: true, minutesLeft: 0 }))).toBeNull();
    expect(spentNote(allowance({ unknown: true, minutesLeft: 0 }))).toBeNull();
  });

  it("each say what is refused and what is kept", () => {
    const spent = allowance({ minutesLeft: 0 });

    for (const feature of FEATURES) {
      const message = aiRefusal(spent, feature)!;
      expect(message).toContain("100 transcription minutes");
      // The second half. Without it the sentence reads as the account having
      // been closed rather than as one allowance having run out.
      expect(message).toMatch(/still here\.$/);
    }
  });

  it("never suggest upgrading, because there is nothing to upgrade to", () => {
    const spent = allowance({ minutesLeft: 0 });

    for (const feature of FEATURES) {
      expect(aiRefusal(spent, feature)).not.toMatch(/upgrade|plan|billing|subscri/i);
    }
    expect(spentNote(spent)).not.toMatch(/upgrade|plan|billing|subscri/i);
  });

  it("say something different for each one", () => {
    const spent = allowance({ minutesLeft: 0 });
    const messages = FEATURES.map((f) => aiRefusal(spent, f));

    // Five features failing with one sentence between them reads as one
    // unexplained fault rather than as five deliberate closures.
    expect(new Set(messages).size).toBe(FEATURES.length);
  });

  it("has a short form for a menu, and it is short", () => {
    const note = spentNote(allowance({ minutesLeft: 0 }))!;

    // It sits in a 16rem dropdown under four greyed rows. The full sentence
    // would be five lines there.
    expect(note.length).toBeLessThan(120);
    expect(note).toContain("stays");
  });
});
