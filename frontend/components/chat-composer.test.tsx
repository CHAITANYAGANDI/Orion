import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

beforeEach(() => vi.clearAllMocks());

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
