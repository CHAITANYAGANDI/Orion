import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "@/components/markdown";
import { ChatMessageBubble } from "@/components/chat-message";
import type { ChatMessage } from "@/lib/types";

/**
 * An answer, rendered.
 *
 * Answers went through `whitespace-pre-wrap`, which is fine for a sentence and
 * wrong for everything else the assistant now produces. A procedure came back
 * as literal `### General next steps` followed by `1. **Find the official
 * site**`, and the reader saw the hashes and the asterisks — so the model
 * writing better structure made the answer harder to read than the paragraph it
 * replaced.
 *
 * Two things are pinned here. The structure survives, and nothing dangerous
 * does: this renders model output into an authenticated page, and the raw-HTML
 * escape hatch (`rehype-raw`) is deliberately absent.
 */

const ANSWER = `The transcript doesn't contain a direct link.

### General next steps

1. **Find the official website**
2. **Choose a pass**
   - Review available options.
3. **Save confirmation**`;

describe("structure", () => {
  it("renders a numbered procedure as a real list", () => {
    const { container } = render(<Markdown>{ANSWER}</Markdown>);

    // The outermost list. There is a nested one too, which the next test is
    // about — `getByRole("list")` would match both and fail on the count.
    const list = container.querySelector("ol")!;
    expect(list.tagName).toBe("OL");
    // Three steps, and a screen reader can count them. A procedure flattened
    // into a paragraph is harder to follow than prose that never tried.
    expect(list.querySelectorAll(":scope > li")).toHaveLength(3);
  });

  it("renders the nested detail under its step", () => {
    const { container } = render(<Markdown>{ANSWER}</Markdown>);

    const nested = container.querySelector("ol > li ul");
    expect(nested).not.toBeNull();
    expect(nested!.textContent).toContain("Review available options.");
  });

  it("renders bold as emphasis rather than as asterisks", () => {
    const { container } = render(<Markdown>{ANSWER}</Markdown>);

    const strong = Array.from(container.querySelectorAll("strong")).map((e) => e.textContent);
    expect(strong).toContain("Find the official website");
  });

  it("renders a heading, restrained enough for a chat bubble", () => {
    const { container } = render(<Markdown>{ANSWER}</Markdown>);

    const heading = screen.getByText("General next steps");
    // `###` and above all land on h3. A banner headline inside a rail is a
    // heading that shouts louder than the answer under it.
    expect(heading.tagName).toBe("H3");
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")).toBeNull();
  });

  it("shows none of the markdown markers", () => {
    const { container } = render(<Markdown>{ANSWER}</Markdown>);

    const text = container.textContent ?? "";
    expect(text).not.toContain("###");
    expect(text).not.toContain("**");
  });

  it("renders plain prose as plain prose", () => {
    // Most answers are a sentence. They must not gain structure they never had.
    const { container } = render(<Markdown>{"The team decided to postpone."}</Markdown>);

    expect(container.querySelectorAll("ol, ul, h3")).toHaveLength(0);
    expect(screen.getByText("The team decided to postpone.")).toBeInTheDocument();
  });

  it("renders a table when the answer is genuinely a grid", () => {
    render(<Markdown>{"| a | b |\n| - | - |\n| 1 | 2 |"}</Markdown>);

    // remark-gfm. Without it this is four lines of pipes.
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});

describe("safety", () => {
  it("does not execute or render raw HTML", () => {
    const { container } = render(
      <Markdown>{'Before <script>window.pwned = 1</script><b>after</b>'}</Markdown>,
    );

    expect(container.querySelector("script")).toBeNull();
    // `skipHtml` drops the tags rather than printing them, so a transcript that
    // quotes a snippet does not turn into markup *or* into visual noise.
    expect(container.querySelector("b")).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("does not render an img, however it is written", () => {
    const { container } = render(
      <Markdown>{"![tracker](https://example.test/a.png)"}</Markdown>,
    );

    // An answer has no reason to fetch a remote resource, and a pixel in one is
    // the cheapest way to learn that somebody read their meeting notes.
    expect(container.querySelector("img")).toBeNull();
  });

  it("drops a javascript: link rather than making it clickable", () => {
    const { container } = render(<Markdown>{"[click](javascript:alert(1))"}</Markdown>);

    const href = container.querySelector("a")?.getAttribute("href");
    expect(href).not.toContain("javascript:");
  });

  it("sends a real link out safely", () => {
    render(<Markdown>{"[the site](https://example.test/register)"}</Markdown>);

    const link = screen.getByRole("link", { name: "the site" });
    expect(link).toHaveAttribute("target", "_blank");
    // noopener/noreferrer for the tab it opens; nofollow because this
    // destination came out of a language model, not out of Recallix.
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(link.getAttribute("rel")).toContain("nofollow");
  });

  it("leaves a user's own question as plain text", () => {
    const prompt: ChatMessage = {
      id: "msg_u",
      conversationId: "cnv_1",
      role: "user",
      content: "# Is this a heading? **no**",
      citations: [],
      createdAt: "2026-08-21T08:00:00Z",
    };

    const { container } = render(<ChatMessageBubble message={prompt} />);

    // Prompts are typed, pasted and dragged in from transcripts. Somebody
    // quoting a line that starts with `#` must see their line, not a heading.
    expect(screen.getByText("# Is this a heading? **no**")).toBeInTheDocument();
    expect(container.querySelector("h1, h3, strong")).toBeNull();
  });
});

describe("the narrow rail", () => {
  it("scrolls a code block inside itself instead of widening the thread", () => {
    const { container } = render(
      <Markdown>{"```\nan extremely long line that would otherwise widen the rail\n```"}</Markdown>,
    );

    const pre = container.querySelector("pre");
    expect(pre?.className).toContain("overflow-x-auto");
  });

  it("scrolls a table inside itself too", () => {
    const { container } = render(<Markdown>{"| a | b |\n| - | - |\n| 1 | 2 |"}</Markdown>);

    // Four columns will not fit four hundred pixels, and the answer should not
    // be what discovers that.
    expect(screen.getByRole("table").parentElement?.className).toContain("overflow-x-auto");
    expect(container.querySelector("table")?.className).toContain("w-full");
  });

  it("wraps a long unbroken token rather than pushing the rail sideways", () => {
    const { container } = render(<Markdown>{"https://example.test/" + "a".repeat(120)}</Markdown>);

    expect(container.firstElementChild?.className).toContain("break-words");
    expect(container.firstElementChild?.className).toContain("min-w-0");
  });

  it("indents a list by a hang, not by a tab stop", () => {
    const { container } = render(<Markdown>{"- one\n- two"}</Markdown>);

    // Every level of nesting costs width the answer does not have.
    expect(container.querySelector("ul")?.className).toContain("ml-4");
  });
});
