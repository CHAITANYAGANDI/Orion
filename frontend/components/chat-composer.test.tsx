import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/**
 * The allowance, stubbed rather than the API behind it.
 *
 * The composer reads it itself - deliberately, so that no surface mounting one
 * can forget to pass it - which would otherwise drag a Redux store into every
 * test here. `lib/allowance.test.ts` covers what the refusals actually say.
 */
let minutesLeft = 100;
vi.mock("@/lib/allowance", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/allowance")>();
  return {
    ...real,
    useAllowance: () => ({
      loading: false,
      unknown: false,
      minutesLeft,
      importsLeft: 3,
      secondsLeft: minutesLeft * 60,
      canRecord: minutesLeft > 0,
      canImport: minutesLeft > 0,
    }),
  };
});

import { ChatComposer, NO_CONTEXT, type ChatContext } from "@/components/chat-composer";
import type { ChatModeOption, MeetingResponse, Project } from "@/lib/types";

/**
 * The composer.
 *
 * Two controls sit beside the box and both change the answer, which is why both
 * are tested on what they send rather than on how they look. "Add context" is
 * not an attachment mechanism — it narrows retrieval — and a chip that stayed on
 * screen without narrowing anything would be the worst possible outcome: a user
 * who believes they asked about three meetings and got an answer from two years
 * of them.
 */
const meetings = [
  { id: "mtg_1", title: "Sprint planning" },
  { id: "mtg_2", title: "Pricing review" },
] as unknown as MeetingResponse[];

const projects = [{ id: "prj_1", name: "Q4 planning" }] as unknown as Project[];

const modes: ChatModeOption[] = [
  { mode: "express", label: "Express", hint: "Balanced for accuracy and speed", isDefault: true },
  { mode: "advanced", label: "Advanced", hint: "For in-depth analysis and actions", isDefault: false },
];

function Harness({
  onSend = vi.fn(),
  onModeChange = vi.fn(),
  initial = NO_CONTEXT,
}: {
  onSend?: (q: string) => void;
  onModeChange?: (m: "express" | "advanced") => void;
  initial?: ChatContext;
}) {
  const [context, setContext] = React.useState<ChatContext>(initial);
  return (
    <ChatComposer
      modes={modes}
      mode="express"
      onModeChange={onModeChange}
      context={context}
      onContextChange={setContext}
      meetings={meetings}
      projects={projects}
      onSend={onSend}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  minutesLeft = 100;
});

describe("asking", () => {
  it("sends on Enter, because a chat box that needs a mouse stops being used", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} />);

    await user.type(screen.getByLabelText(/ask a question/i), "What did we decide?{Enter}");

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("What did we decide?"));
  });

  it("leaves Shift-Enter as the newline", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} />);

    await user.type(screen.getByLabelText(/ask a question/i), "One{Shift>}{Enter}{/Shift}Two");

    expect(onSend).not.toHaveBeenCalled();
  });

  it("will not send an empty question", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} />);

    await user.type(screen.getByLabelText(/ask a question/i), "   {Enter}");

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("clears the box afterwards", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const box = screen.getByLabelText(/ask a question/i) as HTMLTextAreaElement;
    await user.type(box, "Anything{Enter}");

    await waitFor(() => expect(box.value).toBe(""));
  });
});

describe("adding context", () => {
  it("offers conversations and folders under headings a person thinks in", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: /add context/i }));

    expect(await screen.findByText("Conversations")).toBeInTheDocument();
    expect(screen.getByText("Folders")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Sprint planning/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Q4 planning/ })).toBeInTheDocument();
  });

  it("filters both lists at once", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: /add context/i }));
    await user.type(screen.getByLabelText(/find a conversation or folder/i), "pric");

    expect(screen.getByRole("option", { name: /Pricing review/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Sprint planning/ })).not.toBeInTheDocument();
  });

  it("shows what was chosen as a chip that can be taken back off", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: /add context/i }));
    await user.click(screen.getByRole("option", { name: /Sprint planning/ }));
    await user.keyboard("{Escape}");

    const chip = await screen.findByRole("button", { name: /remove sprint planning/i });
    await user.click(chip);

    expect(screen.queryByRole("button", { name: /remove sprint planning/i })).not.toBeInTheDocument();
  });

  it("takes several conversations", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: /add context/i }));
    await user.click(screen.getByRole("option", { name: /Sprint planning/ }));
    await user.click(screen.getByRole("option", { name: /Pricing review/ }));
    await user.keyboard("{Escape}");

    expect(screen.getByRole("button", { name: /remove sprint planning/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove pricing review/i })).toBeInTheDocument();
  });

  it("takes one folder at a time, and says so by replacing rather than adding", async () => {
    // The limit is real — see useWorkspaceChat — so it is enforced in the
    // control rather than silently ignored when the question is asked.
    const second = [
      { id: "prj_1", name: "Q4 planning" },
      { id: "prj_2", name: "Billing" },
    ] as unknown as Project[];
    const user = userEvent.setup();

    function Two() {
      const [context, setContext] = React.useState<ChatContext>(NO_CONTEXT);
      return (
        <ChatComposer
          context={context}
          onContextChange={setContext}
          meetings={[]}
          projects={second}
          onSend={vi.fn()}
        />
      );
    }
    render(<Two />);

    await user.click(screen.getByRole("button", { name: /add context/i }));
    await user.click(screen.getByRole("option", { name: /Q4 planning/ }));
    await user.click(screen.getByRole("option", { name: /Billing/ }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("button", { name: /remove q4 planning/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove billing/i })).toBeInTheDocument();
  });
});

describe("the mode picker", () => {
  it("shows the two settings with what each is for", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: /express/i }));

    expect(await screen.findByText("Balanced for accuracy and speed")).toBeInTheDocument();
    expect(screen.getByText("For in-depth analysis and actions")).toBeInTheDocument();
  });

  it("reports the choice", async () => {
    const onModeChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onModeChange={onModeChange} />);

    await user.click(screen.getByRole("button", { name: /express/i }));
    await user.click(await screen.findByRole("menuitemradio", { name: /advanced/i }));

    expect(onModeChange).toHaveBeenCalledWith("advanced");
  });

  it("is absent entirely where there is no choice to make", () => {
    // The project chat has one retrieval path; a picker offering one option is
    // a control that does nothing.
    render(
      <ChatComposer
        context={NO_CONTEXT}
        onContextChange={vi.fn()}
        meetings={[]}
        projects={[]}
        onSend={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /express/i })).not.toBeInTheDocument();
  });
});

/**
 * Meeting chat reads one meeting through one endpoint. It has no way to widen
 * that, and no chat modes — so the two controls that express those choices must
 * not appear, rather than appear and do nothing.
 */
describe("a scope that cannot change", () => {
  it("states the scope instead of offering a picker", async () => {
    render(<ChatComposer scope="This meeting" onSend={vi.fn()} />);

    expect(screen.getByText("This meeting")).toBeInTheDocument();
    // An "Add context" button on a chat that cannot take any is worse than not
    // offering it: it invites somebody to try, twice.
    expect(screen.queryByRole("button", { name: /add context/i })).not.toBeInTheDocument();
  });

  it("hides the mode picker when no modes are supported", () => {
    render(<ChatComposer scope="This meeting" onSend={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /express/i })).not.toBeInTheDocument();
  });

  it("names the thing it reads, rather than describing it", () => {
    render(<ChatComposer scope="Q4 pricing review" onSend={vi.fn()} />);

    // The chip used to read "This meeting" on every meeting. That was true and
    // became unhelpful the moment the panel could be maximised over the page:
    // with the document covered, "this" names nothing the reader can see.
    expect(screen.getByText("Q4 pricing review")).toBeInTheDocument();
  });

  it("keeps a long name inside the chip, and readable in full on hover", () => {
    const long =
      "Weekly platform sync — migration status, on-call rota and the Q4 roadmap";
    render(<ChatComposer scope={long} onSend={vi.fn()} />);

    // A meeting title is whatever somebody called it, and one that does not
    // truncate wraps the chip onto three lines and pushes the box off the
    // panel. Truncating loses the end of the name, so the whole of it stays
    // reachable rather than being thrown away.
    expect(screen.getByText(long).className).toContain("truncate");
    expect(screen.getByTitle(long)).toBeInTheDocument();
  });

  it("still asks the question", async () => {
    const onSend = vi.fn();
    render(<ChatComposer scope="This meeting" onSend={onSend} />);

    await userEvent.type(screen.getByLabelText("Ask a question"), "What did we decide?{Enter}");

    expect(onSend).toHaveBeenCalledWith("What did we decide?");
  });
});

describe("text handed over from elsewhere on the page", () => {
  it("drops a passage into the box ready to finish", () => {
    render(
      <ChatComposer
        onSend={vi.fn()}
        compose={{ text: "About \"ship on Friday\": ", nonce: 1 }}
      />,
    );

    expect(screen.getByLabelText("Ask a question")).toHaveValue('About "ship on Friday": ');
  });

  it("accepts the same passage twice", () => {
    const { rerender } = render(
      <ChatComposer onSend={vi.fn()} compose={{ text: "Ask about this: ", nonce: 1 }} />,
    );
    const box = screen.getByLabelText("Ask a question");

    // Keyed on the nonce alone. Comparing the text would silently swallow the
    // second attempt at the same passage.
    rerender(<ChatComposer onSend={vi.fn()} compose={{ text: "Ask about this: ", nonce: 2 }} />);

    expect(box).toHaveValue("Ask about this: ");
  });
});


/**
 * The box itself.
 *
 * Two defects that are invisible in a diff and obvious on screen. The rows
 * disagreed about their own left edge — chips at 12px, the text at 16px, the
 * mode picker back at 12px — so the placeholder started a quarter-inch right of
 * the chip above it. And the ceiling on the box's height lived only inside a
 * `useEffect`, so anything that stopped the effect running left a box that grew
 * until it had eaten the conversation above it, with no scrollbar because there
 * was no overflow to scroll.
 */
describe("the box", () => {
  function box() {
    return screen.getByLabelText("Ask a question") as HTMLTextAreaElement;
  }

  /** The `px-*` class a row is using, whatever it happens to be. */
  function padding(el: Element): string | undefined {
    return el.className.split(/\s+/).find((c) => c.startsWith("px-"));
  }

  it("lines its rows up on one left edge", () => {
    render(<ChatComposer scope="This meeting" onSend={vi.fn()} />);

    const rows = Array.from(box().parentElement!.children);
    const paddings = new Set(rows.map(padding));
    expect(paddings.size).toBe(1);
    expect([...paddings][0]).toBeDefined();
  });

  it("cannot grow past its ceiling however much is typed", () => {
    render(<ChatComposer onSend={vi.fn()} />);

    // A real `max-height`, not a number some effect is trusted to clamp to.
    // Eight lines at the box's own line height, plus its padding.
    expect(box().style.maxHeight).toBe("204px");
  });

  it("scrolls once it reaches it", () => {
    render(<ChatComposer onSend={vi.fn()} />);

    // Without this the ceiling would clip the text being typed instead of
    // scrolling to it, which is the same bug wearing a hat.
    expect(box().className).toContain("overflow-y-auto");
  });

  it("never collapses to nothing, however it was measured", async () => {
    render(<ChatComposer scope="This meeting" onSend={vi.fn()} />);

    // jsdom lays nothing out, so `scrollHeight` here is zero — which is
    // precisely what a real browser reports for an element inside a
    // `display: none` ancestor. The panel is portaled into a pane that is
    // hidden until a page claims it, so that is the *first* measurement every
    // chat takes, and writing it back gave a box with no height: no
    // placeholder, no caret, and nothing to make it re-measure afterwards
    // because the text had not changed.
    const el = box();
    await userEvent.type(el, "a question");

    expect(el.style.height).not.toBe("0px");
    expect(el.style.minHeight).toBe("36px");
  });

  it("takes the height it is told when there is something to measure", async () => {
    render(<ChatComposer scope="This meeting" onSend={vi.fn()} />);
    const el = box();
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 84 });

    await userEvent.type(el, "three lines of question");

    // Three rows' worth. The ceiling and floor are CSS; this is the part that
    // has to be measured, and it still is.
    expect(el.style.height).toBe("84px");
  });

  it("scrolls without drawing a scrollbar", () => {
    render(<ChatComposer onSend={vi.fn()} />);

    // Asked for. On a box a few lines tall the bar is more furniture than the
    // content it measures, and the caret already says where you are. The rule
    // is in globals.css; only the class is visible from here.
    expect(box().className).toContain("scrollbar-none");
  });

  it("shows where the focus is", async () => {
    // Fixed scope, so the chip above the box is a label rather than a button
    // and the textarea is the first thing Tab reaches.
    render(<ChatComposer scope="This meeting" onSend={vi.fn()} />);

    // The textarea sets `outline-none` and put nothing in its place, so tabbing
    // into the chat gave no sign of having arrived anywhere. The ring is on the
    // box rather than the textarea because the box is what looks like the input.
    expect(box().parentElement!.className).toContain("focus-within:ring-2");

    await userEvent.tab();
    expect(box()).toHaveFocus();
  });
});

/**
 * What the composer does once the account is out of minutes.
 *
 * <p>The allowance is final - no reset date, nothing to buy - and AI Chat is
 * closed with it. The failure this guards is the quiet one: a box that still
 * accepts a question, sends it, and shows the server's 429 as though the answer
 * had failed. Refusing before the send is the difference between "this is
 * closed" and "this is broken".
 */
describe("once the allowance is spent", () => {
  it("will not send, on Enter or on the button", async () => {
    minutesLeft = 0;
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} />);

    const box = screen.getByLabelText("Ask a question");
    await userEvent.type(box, "What did we decide?{Enter}");

    expect(onSend).not.toHaveBeenCalled();
  });

  it("says why, rather than going quiet", async () => {
    minutesLeft = 0;
    render(<ChatComposer onSend={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/AI Chat is closed/)).toBeInTheDocument());
    // And it does not read as the account being gone.
    expect(screen.getByText(/answers you already have are still here/)).toBeInTheDocument();
  });

  it("is untouched while a minute remains", async () => {
    minutesLeft = 1;
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} />);

    await userEvent.type(screen.getByLabelText("Ask a question"), "Still working?{Enter}");

    expect(onSend).toHaveBeenCalledWith("Still working?");
    expect(screen.queryByText(/AI Chat is closed/)).not.toBeInTheDocument();
  });
});
