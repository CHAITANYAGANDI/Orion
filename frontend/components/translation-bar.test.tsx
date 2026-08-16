import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LanguageOption, MeetingTranslation } from "@/lib/types";

/**
 * Choosing what language to read a meeting in.
 *
 * <p>Two things are being guarded. The picker must offer only languages the
 * product can actually work in — a list that promises Telugu is a list that
 * produces a failed job and no explanation. And it must never let the reader
 * think the recording itself changed: what is translated is the writing about
 * the meeting, and the audio underneath is still the words that were said.
 */
const languages: LanguageOption[] = [
  { code: "en", name: "English", nativeName: "English", rightToLeft: false },
  { code: "es", name: "Spanish", nativeName: "Español", rightToLeft: false },
  { code: "ja", name: "Japanese", nativeName: "日本語", rightToLeft: false },
  { code: "ar", name: "Arabic", nativeName: "العربية", rightToLeft: true },
];

vi.mock("@/lib/api", () => ({
  useGetLanguagesQuery: () => ({ data: languages }),
}));

import { TranslationBar, ORIGINAL } from "@/components/translation-bar";

function translation(over: Partial<MeetingTranslation> = {}): MeetingTranslation {
  return {
    language: "es",
    languageName: "Spanish",
    rightToLeft: false,
    shortSummary: "Acordamos pasar la facturación a Stripe.",
    detailedSummary: "",
    keyPoints: [],
    sections: [],
    actionItems: [],
    segments: [],
    hasBrief: true,
    hasTranscript: false,
    stale: false,
    ...over,
  };
}

function bar(props: Partial<React.ComponentProps<typeof TranslationBar>> = {}) {
  return render(
    <TranslationBar
      sourceLanguage="en"
      value={ORIGINAL}
      onChange={vi.fn()}
      busy={false}
      onRetranslate={vi.fn()}
      {...props}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("TranslationBar choices", () => {
  it("offers the languages the product works in", async () => {
    bar();

    await userEvent.click(screen.getByLabelText("Reading language"));

    expect(screen.getByRole("option", { name: /Spanish/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Japanese/ })).toBeInTheDocument();
  });

  it("shows each language in its own script as well as in English", async () => {
    bar();

    await userEvent.click(screen.getByLabelText("Reading language"));

    // Somebody looking for their own language scans for 日本語, not "Japanese".
    expect(screen.getByRole("option", { name: /日本語/ })).toBeInTheDocument();
  });

  it("does not offer to translate a meeting into the language it is already in", async () => {
    bar({ sourceLanguage: "en" });

    await userEvent.click(screen.getByLabelText("Reading language"));

    // English appears exactly once, as the way back — never as a target, which
    // could only spend a model call to change nothing.
    expect(screen.getAllByRole("option", { name: /English/ })).toHaveLength(1);
    expect(screen.getByRole("option", { name: /English/ })).toHaveTextContent("(original)");
  });

  it("names the original by its language rather than calling it 'original'", async () => {
    bar({ sourceLanguage: "en" });

    await userEvent.click(screen.getByLabelText("Reading language"));

    // "English" is what the reader is choosing between; that it happens to be
    // the source is a fact about the meeting, not the name of an option.
    expect(screen.getByRole("option", { name: /English \(original\)/ })).toBeInTheDocument();
  });

  it("still offers a way back when the meeting's language was never detected", async () => {
    bar({ sourceLanguage: null });

    await userEvent.click(screen.getByLabelText("Reading language"));

    expect(screen.getByRole("option", { name: "Original" })).toBeInTheDocument();
  });

  it("reports the choice as a language code", async () => {
    const onChange = vi.fn();
    bar({ onChange });

    await userEvent.click(screen.getByLabelText("Reading language"));
    await userEvent.click(screen.getByRole("option", { name: /Spanish/ }));

    expect(onChange).toHaveBeenCalledWith("es");
  });
});

describe("TranslationBar state", () => {
  it("says what was translated, and what was not", () => {
    bar({ value: "es", translation: translation() });

    // The audio is still somebody speaking English. A reader who forgets that
    // will quote a translated sentence as a thing that was said aloud.
    expect(screen.getByText(/the recording is still in English/i)).toBeInTheDocument();
  });

  it("says when the meeting has moved on since it was translated", () => {
    bar({ value: "es", translation: translation({ stale: true }) });

    expect(screen.getByText(/changed after this was translated/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retranslate/ })).toBeInTheDocument();
  });

  it("offers no retranslate when there is nothing stale about it", () => {
    bar({ value: "es", translation: translation() });

    expect(screen.queryByRole("button", { name: /Retranslate/ })).not.toBeInTheDocument();
  });

  it("shows progress rather than a silent wait", () => {
    bar({ value: "es", busy: true });

    // Translating a brief is seconds and a transcript is tens of them; an
    // unchanged screen for that long reads as a broken click.
    expect(screen.getByText(/Translating/)).toBeInTheDocument();
  });
});
