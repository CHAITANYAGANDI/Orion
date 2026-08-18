import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { OutlineNav } from "@/components/outline-nav";
import type { SummarySection } from "@/lib/types";

/**
 * The outline rail.
 *
 * <p>What is being defended is the handling of a heading with no timestamp,
 * which is a normal outcome rather than an error. The ai-service establishes
 * the time by finding the line the model says opened the topic in the
 * transcript, and refuses to invent one when it cannot — so summaries written
 * before that existed have none at all, and a fresh one usually has a few.
 *
 * <p>There are two tempting ways to tidy that up and both are worse than the
 * grey text. Hiding the unanchored headings makes this list disagree with the
 * outline on the Summary tab, and the reader is left wondering which topics
 * vanished. Linking them to 0:00, or to the nearest heading that does have a
 * time, produces a link that lands on the wrong minute — which is
 * indistinguishable from a transcript that contradicts its own summary.
 */
function outline(...groups: { heading: string; startSeconds?: number | null }[]): SummarySection {
  return {
    key: "outline",
    title: "Outline",
    kind: "outline",
    text: "",
    bullets: [],
    groups: groups.map((g) => ({
      heading: g.heading,
      bullets: ["something that was said"],
      startSeconds: g.startSeconds ?? null,
    })),
  };
}

describe("OutlineNav", () => {
  it("lists the headings with the time each topic began", () => {
    render(
      <OutlineNav
        sections={[
          outline(
            { heading: "Corporate events", startSeconds: 5 },
            { heading: "Product announcements", startSeconds: 184 },
          ),
        ]}
        onSeek={vi.fn()}
      />,
    );

    expect(screen.getByText("Corporate events")).toBeInTheDocument();
    expect(screen.getByText("00:05")).toBeInTheDocument();
    expect(screen.getByText("03:04")).toBeInTheDocument();
  });

  it("jumps to the moment the topic started", async () => {
    const onSeek = vi.fn();
    render(
      <OutlineNav sections={[outline({ heading: "Roadmap", startSeconds: 184 })]} onSeek={onSeek} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /Roadmap/ }));

    expect(onSeek).toHaveBeenCalledWith(184);
  });

  it("shows a heading it could not place, but does not make it clickable", () => {
    render(
      <OutlineNav
        sections={[outline({ heading: "Something nobody could place", startSeconds: null })]}
        onSeek={vi.fn()}
      />,
    );

    // Present, so this list still agrees with the Summary tab.
    expect(screen.getByText("Something nobody could place")).toBeInTheDocument();
    // Inert, because the only honest destination is none.
    expect(
      screen.queryByRole("button", { name: /Something nobody could place/ }),
    ).not.toBeInTheDocument();
  });

  it("explains the grey ones, so nobody concludes the page is broken", () => {
    render(
      <OutlineNav
        sections={[
          outline(
            { heading: "Placed", startSeconds: 5 },
            { heading: "Not placed", startSeconds: null },
          ),
        ]}
        onSeek={vi.fn()}
      />,
    );

    expect(screen.getByText(/could not be matched to a line in the transcript/i))
      .toBeInTheDocument();
  });

  it("stays quiet when every heading is anchored", () => {
    render(
      <OutlineNav
        sections={[
          outline({ heading: "One", startSeconds: 5 }, { heading: "Two", startSeconds: 60 }),
        ]}
        onSeek={vi.fn()}
      />,
    );

    // A footnote about a failure that did not happen is noise on every page.
    expect(screen.queryByText(/could not be matched/i)).not.toBeInTheDocument();
  });

  it("reads only the outline, not every section that happens to have groups", () => {
    // The Interview template uses the outline *shape* for questions and their
    // answers. Those headings are questions, not topics, and navigating a
    // transcript by them would be a different feature wearing this one's UI.
    const questions: SummarySection = {
      ...outline({ heading: "Why did you leave your last role?", startSeconds: 30 }),
      key: "questionsAndResponses",
      title: "Questions and responses",
    };
    render(
      <OutlineNav
        sections={[questions, outline({ heading: "The actual outline", startSeconds: 5 })]}
        onSeek={vi.fn()}
      />,
    );

    expect(screen.getByText("The actual outline")).toBeInTheDocument();
    expect(screen.getByText("Why did you leave your last role?")).toBeInTheDocument();
  });

  it("says why it is empty rather than showing nothing", () => {
    render(<OutlineNav sections={[]} onSeek={vi.fn()} />);

    // A blank rail beside a transcript reads as a component that failed to
    // load. Meetings summarized before templates existed have no outline, and
    // that is worth one sentence.
    expect(screen.getByText(/no outline/i)).toBeInTheDocument();
  });

  it("ignores a heading that is only whitespace", () => {
    render(
      <OutlineNav
        sections={[outline({ heading: "   ", startSeconds: 5 }, { heading: "Real", startSeconds: 9 })]}
        onSeek={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
