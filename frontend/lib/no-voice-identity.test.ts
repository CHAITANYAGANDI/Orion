/**
 * Cross-meeting voice identity is gone from the interface.
 *
 * Stage 3A removed the product feature. There is no "Rematch speakers", no
 * saved-voices list, no learning toggle, and no client that could ask for any
 * of them — a user can no longer be told, anywhere, that Reverie remembers what
 * somebody sounds like.
 *
 * These read the source rather than render it, because what has to be true is
 * an absence: a rendering test can only assert that a control is not on the
 * screen it happened to render, and the failure worth catching is the control
 * coming back on a screen this file never thought to check.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const DIRS = ["lib", "components", "app"];

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  for (const dir of DIRS) walk(path.join(ROOT, dir));
  return out;
}

describe("cross-meeting voice identity", () => {
  it("has no module of its own left", () => {
    expect(fs.existsSync(path.join(ROOT, "lib/rematch.ts"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "lib/rematch.test.ts"))).toBe(false);
  });

  it("has no API client for it", () => {
    const api = fs.readFileSync(path.join(ROOT, "lib/api.ts"), "utf8");
    for (const gone of [
      "rematchSpeakers",
      "getSpeakerSettings",
      "setSpeakerLearning",
      "deleteSpeakerProfile",
      "speakers/rematch",
    ]) {
      expect(api, gone).not.toContain(gone);
    }
  });

  it("has no types for it", () => {
    const types = fs.readFileSync(path.join(ROOT, "lib/types.ts"), "utf8");
    for (const gone of ["SpeakerRematchResult", "SpeakerProfile", "SpeakerSettings"]) {
      expect(types, gone).not.toContain(gone);
    }
    // The meeting-local ones stay: who spoke, and how much.
    expect(types).toContain("SpeakerStats");
    expect(types).toContain("TranscriptSegment");
  });

  it("shows no control or setting for it anywhere", () => {
    // Wording a user could read, in any source file. Comments are excluded by
    // being checked case-insensitively against product phrases only — a comment
    // is free to say the feature was removed.
    const banned = [
      "Rematch speakers",
      "Rematching speakers",
      "Voice recognition",
      "Saved voices",
      "voice template",
    ];
    const offenders: string[] = [];
    for (const file of sources()) {
      if (file.endsWith("no-voice-identity.test.ts")) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const phrase of banned) {
        if (text.includes(phrase)) offenders.push(`${path.relative(ROOT, file)}: ${phrase}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still renames speakers inside one meeting", () => {
    // The thing that must NOT have gone with it. A rename is meeting-local and
    // is how a user puts a name to a voice; it simply no longer teaches anything.
    const api = fs.readFileSync(path.join(ROOT, "lib/api.ts"), "utf8");
    expect(api).toContain("renameSpeakers");
    expect(api).toContain("setSegmentSpeaker");
  });
});
