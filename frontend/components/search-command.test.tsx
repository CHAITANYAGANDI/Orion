import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, SearchFacets } from "@/lib/types";

/**
 * The search overlay.
 *
 * The box replaced eight dropdowns, so the thing that has to be true is that it
 * still reaches every filter they held — and that it teaches the grammar rather
 * than assuming it. A search bar whose syntax you have to already know is a
 * search bar people type plain words into forever, which is the state the
 * dropdowns existed to avoid.
 *
 * The other half is that a half-typed filter never becomes a search. `from:pri`
 * submitted as free text returns nothing and looks like the archive is empty.
 */
const { push } = vi.hoisted(() => ({ push: vi.fn() }));

const facets: SearchFacets = {
  speakers: ["Priya", "Marcus"],
  owners: ["Marcus"],
  tags: ["q4"],
  types: ["standup"],
  statuses: ["READY"],
};

const projects = [
  { id: "prj_1", name: "Q4 planning" },
] as unknown as Project[];

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("@/lib/api", () => ({
  useGetSearchFacetsQuery: () => ({ data: facets }),
  useGetProjectsQuery: () => ({ data: projects }),
}));

import { SearchCommand } from "@/components/search-command";

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no rAF scheduling worth waiting on; run the focus callback now.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

describe("opening", () => {
  it("shows nothing at all when closed", () => {
    render(<SearchCommand open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByLabelText("Search")).not.toBeInTheDocument();
  });

  it("teaches the grammar before anything is typed", () => {
    // Four examples cost a moment to read and replace a help page.
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    expect(screen.getByText(/Search everything at once/i)).toBeInTheDocument();
    expect(screen.getByText(/from:priya budget/)).toBeInTheDocument();
  });

  it("says what it searches, which is more than conversations", () => {
    render(<SearchCommand open onOpenChange={vi.fn()} />);
    expect(
      screen.getByPlaceholderText("Search conversations, people, folders, time frame"),
    ).toBeInTheDocument();
  });
});

describe("suggesting", () => {
  it("offers a filter as soon as its name is recognisable", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Search"), "fr");

    expect(await screen.findByRole("option", { name: /from:/ })).toBeInTheDocument();
  });

  it("offers the workspace's own speakers, not a list to spell from memory", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Search"), "from:");

    expect(await screen.findByRole("option", { name: /Priya/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Marcus/ })).toBeInTheDocument();
  });

  it("offers folders under in:, including unfiled", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Search"), "in:");

    expect(await screen.findByRole("option", { name: /Q4 planning/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /unfiled/ })).toBeInTheDocument();
  });

  it("says nothing for an ordinary word", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Search"), "stripe");

    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("completes a chosen value into the box", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    const input = screen.getByLabelText("Search") as HTMLInputElement;
    await user.type(input, "from:pri");
    await user.click(await screen.findByRole("option", { name: /Priya/ }));

    await waitFor(() => expect(input.value).toBe("from:Priya "));
  });
});

describe("showing what is narrowed", () => {
  it("puts a chip up for each filter, so the narrowing is never invisible", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Search"), "from:Priya stripe");

    expect(await screen.findByText("from: Priya")).toBeInTheDocument();
  });
});

describe("searching", () => {
  it("carries the filters into the results page's URL", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Search"), "from:Marcus stripe");
    await user.click(screen.getByRole("button", { name: /^search$/i }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    const url = push.mock.calls[0][0] as string;
    expect(url).toContain("/search?");
    expect(url).toContain("speaker=Marcus");
    expect(url).toContain("q=stripe");
  });

  it("completes a half-typed filter on Enter instead of searching for it", async () => {
    // `from:pri` submitted as free text returns nothing and looks like the
    // archive is empty.
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    const input = screen.getByLabelText("Search") as HTMLInputElement;
    await user.type(input, "from:pri");
    await user.keyboard("{Enter}");

    expect(push).not.toHaveBeenCalled();
    await waitFor(() => expect(input.value).toBe("from:Priya "));
  });

  it("searches on Enter once there is nothing left to complete", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Search"), "stripe");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(push).toHaveBeenCalled());
  });

  it("closes on Escape without searching", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText("Search"), "stripe");
    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).not.toHaveBeenCalled();
  });
});
