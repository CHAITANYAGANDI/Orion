import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LanguageOption, MeetingTranslation } from "@/lib/types";

/**
 * Choosing what language to read a meeting in, and being told when you are.
 *
 * <p>Three things are being guarded. The picker must offer only languages the
 * product can actually work in — a list that promises Telugu is a list that
 * produces a failed job and no explanation. It must never let the reader think
 * the recording itself changed: what is translated is the writing about the
 * meeting, and the audio underneath is still the words that were said.
 *
 * <p>And the indicator has to appear whenever a translation is on screen. That
 * is new weight: this used to be a bar that was always visible, so a reader
 * could see at a glance what language they were in. Now the control is behind
 * the ⋯ menu, and a translated summary is indistinguishable from an original
 * one unless {@link ReadingIn} says otherwise. The last group is the whole
 * reason that component exists.
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

import { TranslationDialog, ReadingIn, ORIGINAL } from "@/components/translation-dialog";

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

function dialog(props: Partial<React.ComponentProps<typeof TranslationDialog>> = {}) {
  return render(
    <TranslationDialog
      open
      onOpenChange={vi.fn()}
      sourceLanguage="en"
      value={ORIGINAL}
      onChange={vi.fn()}
      busy={false}
      {...props}
    />,
  );
}

function reading(props: Partial<React.ComponentProps<typeof ReadingIn>> = {}) {
  return render(
    <ReadingIn
      sourceLanguage="en"
      language={ORIGINAL}
      busy={false}
      onShowOriginal={vi.fn()}
      onRetranslate={vi.fn()}
      {...props}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("the languages offered", () => {
  it("offers the languages the product works in", () => {
    dialog();

    expect(screen.getByRole("button", { name: /Spanish/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Japanese/ })).toBeInTheDocument();
  });

  it("shows each language in its own script as well as in English", () => {
    dialog();

    // Somebody looking for their own language scans for 日本語, not "Japanese".
    expect(screen.getByRole("button", { name: /日本語/ })).toBeInTheDocument();
  });

  it("does not offer to translate a meeting into the language it is already in", () => {
    dialog({ sourceLanguage: "en" });

    // English appears exactly once, as the way back — never as a target, which
    // could only spend a model call to change nothing.
    expect(screen.getAllByRole("button", { name: /English/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /English/ })).toHaveTextContent("(original)");
  });

  it("names the original by its language rather than calling it 'original'", () => {
    dialog({ sourceLanguage: "en" });

    // "English" is what the reader is choosing between; that it happens to be
    // the source is a fact about the meeting, not the name of an option.
    expect(screen.getByRole("button", { name: /English \(original\)/ })).toBeInTheDocument();
  });

  it("still offers a way back when the meeting's language was never detected", () => {
    dialog({ sourceLanguage: null });

    expect(screen.getByRole("button", { name: /Original/ })).toBeInTheDocument();
  });

  it("marks the ones already paid for", () => {
    dialog({
      available: [
        {
          language: "es",
          languageName: "Spanish",
          hasTranscript: false,
          stale: false,
          updatedAt: "2026-08-19T00:00:00Z",
        },
      ],
    });

    // The difference between an instant switch and a thirty-second one is the
    // difference between browsing and committing.
    expect(screen.getByRole("button", { name: /Spanish/ })).toHaveTextContent(
      "Already translated",
    );
    expect(screen.getByRole("button", { name: /Japanese/ })).not.toHaveTextContent(
      "Already translated",
    );
  });

  it("says the recording is not what is being translated", () => {
    dialog();

    // A reader who forgets that will quote a translated sentence as a thing
    // somebody said aloud.
    expect(screen.getByText(/recording and the transcript stay in English/i)).toBeInTheDocument();
  });
});

describe("choosing one", () => {
  it("reports the choice as a language code", async () => {
    const onChange = vi.fn();
    dialog({ onChange });

    await userEvent.click(screen.getByRole("button", { name: /Spanish/ }));

    expect(onChange).toHaveBeenCalledWith("es");
  });

  it("closes itself, since the answer is the page behind it", async () => {
    const onOpenChange = vi.fn();
    dialog({ onOpenChange });

    await userEvent.click(screen.getByRole("button", { name: /Spanish/ }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("spends nothing on choosing the language already being read", async () => {
    const onChange = vi.fn();
    dialog({ value: "es", onChange });

    await userEvent.click(screen.getByRole("button", { name: /Spanish/ }));

    // The page fires the mutation on every change; re-picking the current one
    // would be a model call to arrive where the reader already is.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("marks the one being read now", () => {
    dialog({ value: "es" });

    expect(screen.getByRole("button", { name: /Spanish/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
});

describe("knowing you are reading a translation", () => {
  it("says nothing at all about a meeting in its own language", () => {
    const { container } = reading({ language: ORIGINAL });

    // The row this replaced was on screen always, saying "English (original)"
    // on nearly every meeting. Nothing to report, nothing rendered.
    expect(container).toBeEmptyDOMElement();
  });

  it("names the language being read, once there is one", () => {
    reading({ language: "es", translation: translation() });

    // The only thing on the page that distinguishes a translated summary from
    // one in the meeting's own words, now the picker is behind a menu.
    expect(screen.getByText(/Reading in Spanish/)).toBeInTheDocument();
  });

  it("offers the way back without opening the menu again", async () => {
    const onShowOriginal = vi.fn();
    reading({ language: "es", translation: translation(), onShowOriginal });

    await userEvent.click(screen.getByRole("button", { name: /Show English/ }));

    expect(onShowOriginal).toHaveBeenCalled();
  });

  it("says when the meeting has moved on since it was translated", () => {
    reading({ language: "es", translation: translation({ stale: true }) });

    expect(screen.getByText(/Translated before the meeting last changed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retranslate/ })).toBeInTheDocument();
  });

  it("offers no retranslate when there is nothing stale about it", () => {
    reading({ language: "es", translation: translation() });

    expect(screen.queryByRole("button", { name: /Retranslate/ })).not.toBeInTheDocument();
  });

  it("shows progress rather than a silent wait", () => {
    reading({ language: "es", busy: true });

    // Translating a brief is seconds and a transcript is tens of them; an
    // unchanged screen for that long reads as a broken click — and the dialog
    // that started it has already closed.
    expect(screen.getByText(/Translating into Spanish/)).toBeInTheDocument();
  });

  it("shows progress even on the way back to the original", () => {
    reading({ language: ORIGINAL, busy: true });

    // Guards the early return being written as "original means render nothing":
    // a retranslate fired from here would leave the page silent.
    expect(screen.getByText(/Translating/)).toBeInTheDocument();
  });
});
