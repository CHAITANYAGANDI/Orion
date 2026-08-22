import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import {
  closeSearch,
  openSearch,
  resetSearchOverlay,
  useSearchOverlay,
} from "@/lib/search-overlay";

/**
 * Who has the search box open, and what is in it.
 *
 * <p>A store rather than a prop because of one caller: "Search in folder", on a
 * folder's overflow menu, has to open the box *with a query already typed* —
 * and it is three components below the shell that draws the box. This is the
 * seam that stops every page in between declaring a prop it does not use.
 */
function Probe() {
  const overlay = useSearchOverlay();
  return <p data-testid="state">{overlay.open ? `open:${overlay.initial}` : "closed"}</p>;
}

beforeEach(() => {
  resetSearchOverlay();
});

describe("the search overlay store", () => {
  it("starts closed", () => {
    render(<Probe />);
    expect(screen.getByTestId("state")).toHaveTextContent("closed");
  });

  it("opens empty for Ctrl-K and the header button", () => {
    render(<Probe />);

    act(() => openSearch());

    expect(screen.getByTestId("state")).toHaveTextContent("open:");
  });

  it("opens with a query already in it", () => {
    render(<Probe />);

    act(() => openSearch('in:"Q4 planning" '));

    expect(screen.getByTestId("state")).toHaveTextContent('open:in:"Q4 planning"');
  });

  it("forgets the seed when it closes", () => {
    render(<Probe />);
    act(() => openSearch('in:"Q4 planning" '));

    act(() => closeSearch());
    act(() => openSearch());

    // Otherwise Ctrl-K after a "Search in folder" reopens the box still
    // narrowed to a folder nobody is standing in any more.
    expect(screen.getByTestId("state")).toHaveTextContent("open:");
    expect(screen.getByTestId("state")).not.toHaveTextContent("Q4 planning");
  });

  it("tells every listener, so the shell and a probe cannot disagree", () => {
    render(
      <>
        <Probe />
        <Probe />
      </>,
    );

    act(() => openSearch("budget"));

    for (const el of screen.getAllByTestId("state")) {
      expect(el).toHaveTextContent("open:budget");
    }
  });
});
