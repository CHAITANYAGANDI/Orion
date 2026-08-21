import { describe, it, expect, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, act } from "@testing-library/react";
import {
  SIDE_PANE_ID,
  SidePane,
  resetSidePane,
  toggleSidePane,
  toggleSidePaneExpanded,
  useSidePane,
} from "@/components/side-pane";

/**
 * The shell's third column, and how a page fills it.
 *
 * Two things have to hold or the pane is worse than the `<aside>` it replaced.
 * It has to take no width on a page that has no rail — a 28rem strip of empty
 * card beside a meeting that is still processing is a layout bug people report
 * as a blank screen. And a page that *does* have one has to be able to hand it
 * over from anywhere in its tree, because the rail needs the page's queries and
 * the shell has none of them.
 */

/** Stands in for the shell: the target element, and the state it renders from. */
function Shell({ children }: { children?: React.ReactNode }) {
  const pane = useSidePane();
  return (
    <>
      <p>{pane.occupied ? "occupied" : "empty"}</p>
      <p>{pane.open ? "open" : "closed"}</p>
      <p>{pane.expanded ? "maximised" : "a column"}</p>
      {/* Hidden when closed, never unmounted — the same thing the real shell
          does, and for the same reason: it is the portal's target, and it is
          holding whatever was being typed. */}
      <div id={SIDE_PANE_ID} data-testid="pane" hidden={!pane.open} />
      {children}
    </>
  );
}

beforeEach(() => {
  resetSidePane();
});

describe("SidePane", () => {
  it("renders a page's rail into the shell's pane", () => {
    render(
      <Shell>
        <SidePane>
          <p>Ask this meeting</p>
        </SidePane>
      </Shell>,
    );

    // In the shell's element, not where the page wrote it. That is the whole
    // trick: the component, its state and its queries stay on the page and
    // only the output moves.
    expect(screen.getByTestId("pane")).toHaveTextContent("Ask this meeting");
  });

  it("is empty until a page fills it", () => {
    render(<Shell />);

    expect(screen.getByText("empty")).toBeInTheDocument();
  });

  it("reports itself occupied once a page has", () => {
    render(
      <Shell>
        <SidePane>
          <p>rail</p>
        </SidePane>
      </Shell>,
    );

    expect(screen.getByText("occupied")).toBeInTheDocument();
  });

  it("empties again when the page that filled it goes", () => {
    const { rerender } = render(
      <Shell>
        <SidePane>
          <p>rail</p>
        </SidePane>
      </Shell>,
    );
    expect(screen.getByText("occupied")).toBeInTheDocument();

    // Navigating to a page with no rail — settings, or a meeting that is still
    // processing. The column has to close, not stand there empty.
    rerender(<Shell />);
    expect(screen.getByText("empty")).toBeInTheDocument();
  });

  it("stays occupied when one of two overlapping pages leaves", () => {
    // React mounts the next tree before unmounting the last one during a
    // transition, so both rails exist for a frame. A boolean would be switched
    // off by the one that left and the pane would blink shut mid-navigation.
    //
    // Both rails are passed as an array on every render, and that is load
    // bearing: a single child becoming an array is a remount, not a
    // reconciliation, so writing this the obvious way tears down the rail that
    // was meant to be staying and tests nothing.
    const { rerender } = render(
      <Shell>
        {[
          <SidePane key="a">
            <p>first</p>
          </SidePane>,
          <SidePane key="b">
            <p>second</p>
          </SidePane>,
        ]}
      </Shell>,
    );

    rerender(
      <Shell>
        {[
          <SidePane key="b">
            <p>second</p>
          </SidePane>,
        ]}
      </Shell>,
    );

    expect(screen.getByText("occupied")).toBeInTheDocument();
    expect(screen.getByTestId("pane")).toHaveTextContent("second");
  });

  it("renders nothing when the shell has no pane to render into", () => {
    // The shared conversation page and the sign-in screen are outside the app
    // shell. A rail rendered there must not throw and must not claim a column
    // that does not exist.
    render(
      <SidePane>
        <p>rail</p>
      </SidePane>,
    );

    expect(screen.queryByText("rail")).not.toBeInTheDocument();
  });
});

describe("collapsing it", () => {
  it("starts open", () => {
    render(<Shell />);

    expect(screen.getByText("open")).toBeInTheDocument();
  });

  it("closes and opens again", async () => {
    render(<Shell />);

    await act(async () => toggleSidePane());
    expect(screen.getByText("closed")).toBeInTheDocument();

    await act(async () => toggleSidePane());
    expect(screen.getByText("open")).toBeInTheDocument();
  });

  it("keeps what is in the pane while it is closed", async () => {
    render(
      <Shell>
        <SidePane>
          <input aria-label="Ask a question" defaultValue="half a question" />
        </SidePane>
      </Shell>,
    );

    await act(async () => toggleSidePane());
    await act(async () => toggleSidePane());

    // Hidden, never unmounted. Collapsing the chat to read a transcript and
    // reopening it must not throw away what was being typed.
    expect(screen.getByLabelText("Ask a question")).toHaveValue("half a question");
  });

  it("survives the page underneath changing", async () => {
    const { rerender } = render(<Shell />);
    await act(async () => toggleSidePane());

    rerender(
      <Shell>
        <SidePane>
          <p>rail</p>
        </SidePane>
      </Shell>,
    );

    // A collapse is a decision about the window, not about the page. Reopening
    // it on every navigation would make the button useless.
    expect(screen.getByText("closed")).toBeInTheDocument();
  });
});

describe("maximising it", () => {
  it("starts as a column", () => {
    render(<Shell />);

    expect(screen.getByText("a column")).toBeInTheDocument();
  });

  it("expands and comes back", async () => {
    render(<Shell />);

    await act(async () => toggleSidePaneExpanded());
    expect(screen.getByText("maximised")).toBeInTheDocument();

    await act(async () => toggleSidePaneExpanded());
    expect(screen.getByText("a column")).toBeInTheDocument();
  });

  it("shrinks back when the page that was maximised goes", async () => {
    const { rerender } = render(
      <Shell>
        <SidePane>
          <p>rail</p>
        </SidePane>
      </Shell>,
    );
    await act(async () => toggleSidePaneExpanded());

    rerender(<Shell />);

    // The control that undoes this lives inside the rail that was maximised.
    // Carrying the state to the next page would leave a panel covering the
    // screen with nothing on it offering to move.
    expect(screen.getByText("a column")).toBeInTheDocument();
  });

  it("stays maximised when one of two overlapping pages leaves", async () => {
    const { rerender } = render(
      <Shell>
        {[
          <SidePane key="a">
            <p>first</p>
          </SidePane>,
          <SidePane key="b">
            <p>second</p>
          </SidePane>,
        ]}
      </Shell>,
    );
    await act(async () => toggleSidePaneExpanded());

    rerender(
      <Shell>
        {[
          <SidePane key="b">
            <p>second</p>
          </SidePane>,
        ]}
      </Shell>,
    );

    // Mid-navigation the pane is never unoccupied, so nothing has left and
    // there is nothing to reset. Dropping the maximise here would make it
    // flicker every time a route transition overlapped two rails.
    expect(screen.getByText("maximised")).toBeInTheDocument();
  });
});

describe("resetSidePane", () => {
  it("puts it back to empty and open", async () => {
    render(<Shell />);
    await act(async () => toggleSidePane());

    await act(async () => resetSidePane());

    expect(screen.getByText("empty")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
    expect(screen.getByText("a column")).toBeInTheDocument();
  });
});
