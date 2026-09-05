"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Gavel, Pencil, Plus, TriangleAlert, X } from "lucide-react";
import {
  useGetInsightsQuery,
  useAddInsightMutation,
  useUpdateInsightMutation,
  useDeleteInsightMutation,
} from "@/lib/api";
import type { Insight } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * What the meeting settled, and what it flagged.
 *
 * These rows are read out of the summary the model already wrote — the same
 * words as the Decisions section further down the page — rather than extracted
 * a second time. That is what stops the two from disagreeing.
 *
 * They are editable because they are not only shown here. Workspace chat is
 * handed the decision record as the authority on what was agreed and when, so a
 * wrong row is a wrong answer to "does this conflict with what we decided in
 * March?", not a cosmetic blemish. Being able to correct one is what earns the
 * store that role.
 *
 * ## Why an empty card is not drawn
 *
 * Four of the eight templates carry a decisions section and three carry risks
 * or blockers; Interview, 1:1 and Memo deliberately carry neither. So on those
 * meetings there is nothing to read here, and there never will be — and the
 * page was drawing two cards anyway, one of them explaining that the template
 * does not track decisions. A card whose only content is an apology for
 * existing is worth less than the space it takes, and it took that space on
 * every such meeting.
 *
 * The nothing is not lost by hiding it. Where a template *does* track
 * decisions and the meeting settled none, the summary above says so in its own
 * Decisions section — that section is the source these rows are read from. A
 * second statement of the same absence underneath it is not more honest, only
 * longer.
 *
 * And no invitation in its place. A first pass at this left a pair of "Add a
 * decision" / "Add a risk" links where the cards had been, reasoning that a
 * decision the brief missed is worth recording by hand. That is not how these
 * get used. The rows are a *reading* of the summary, and somebody who thinks
 * the summary is wrong fixes the row that is wrong or rewrites with another
 * template — nobody types a decision into an empty page to keep a card
 * company. So on a meeting that settled nothing the panel is absent, and the
 * summary tab ends at the action items, which is where it ended before any of
 * this was extracted.
 */
/*
 * Audited alongside the transcript, the summary and the action items, and
 * deliberately left alone.
 *
 * <p>Those three each had a sentence to say when they had nothing -- "No
 * summary available.", "Transcript unavailable." -- and each was saying it on
 * the strength of `data` being undefined, which is equally what a failed
 * request looks like. This panel has no such sentence: with nothing to show it
 * renders nothing at all, for the reasons in the header above. So a failed
 * insights request produces an absent card rather than a false claim, and there
 * is no empty state here to make honest.
 *
 * <p>Which also means: <b>do not add one.</b> A "No decisions were recorded"
 * card derived from `(data ?? [])` would be this bug, freshly introduced, in
 * the one place on the page that did not have it.
 */
export function InsightsPanel({ meetingId }: { meetingId: string }) {
  const { data, isLoading } = useGetInsightsQuery(meetingId);
  const decisions = React.useMemo(
    () => (data ?? []).filter((i) => i.kind === "DECISION"),
    [data],
  );
  const risks = React.useMemo(() => (data ?? []).filter((i) => i.kind === "RISK"), [data]);

  if (isLoading) {
    // Held space rather than nothing: these sit under the action items, and
    // appearing late would shove the reader's place down the page.
    return <Skeleton className="h-24 w-full" />;
  }

  const all: CardSpec[] = [
    { kind: "DECISION", title: "Decisions", icon: Gavel, items: decisions },
    { kind: "RISK", title: "Risks and blockers", icon: TriangleAlert, items: risks },
  ];
  const cards = all.filter((c) => c.items.length > 0);

  if (cards.length === 0) return null;

  return (
    /*
     * Stacked, not side by side.
     *
     * <p>They were a two-column grid, with a lone card widened to fill the row
     * so it did not leave a hole where the reader looks for the one that is not
     * there. Inside the 680px measure two columns are ~330px each, which is too
     * narrow for a sentence about what was decided — and the special case
     * disappears with the grid rather than needing to be handled.
     *
     * <p>They are sections of the brief now, in the same shape as its own:
     * a heading, a count, and rows.
     */
    <div className="space-y-7">
      {cards.map((c) => (
        <InsightList
          key={c.kind}
          meetingId={meetingId}
          kind={c.kind}
          title={c.title}
          icon={c.icon}
          items={c.items}
        />
      ))}
    </div>
  );
}

/** One card's worth of configuration, so the two are declared side by side. */
interface CardSpec {
  kind: Insight["kind"];
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  items: Insight[];
}

function InsightList({
  meetingId,
  kind,
  title,
  icon: Icon,
  items,
}: {
  meetingId: string;
  kind: Insight["kind"];
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  items: Insight[];
}) {
  const [add, { isLoading: adding }] = useAddInsightMutation();
  const [draft, setDraft] = React.useState("");
  const [composing, setComposing] = React.useState(false);

  async function submit() {
    const text = draft.trim();
    if (!text) {
      setComposing(false);
      return;
    }
    try {
      await add({ meetingId, kind, text }).unwrap();
      setDraft("");
      setComposing(false);
    } catch {
      toast.error("Couldn't save that.");
    }
  }

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-2 text-title-3 font-headline text-ink">
        <Icon className="h-4 w-4 text-ink-3" /> {title}
        {items.length > 0 && (
          <span className="tabular font-mono text-cap font-normal text-ink-4">
            {items.length}
          </span>
        )}
      </h3>
      <div className="space-y-2">
        {items.map((item) => (
          <InsightRow key={item.id} item={item} meetingId={meetingId} />
        ))}

        {composing ? (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={draft}
              disabled={adding}
              placeholder={kind === "DECISION" ? "What was decided?" : "What's at risk?"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") {
                  setDraft("");
                  setComposing(false);
                }
              }}
              className="h-8 border-edge bg-surface-raised text-callout"
            />
            <Button size="icon" variant="ghost" aria-label="Save" onClick={submit} disabled={adding}>
              <Check className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setComposing(true)}
            className="no-print inline-flex items-center gap-1 pt-1 text-foot text-ink-3 transition-colors hover:text-ink"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        )}
      </div>
    </section>
  );
}

function InsightRow({ item, meetingId }: { item: Insight; meetingId: string }) {
  const [update, { isLoading: saving }] = useUpdateInsightMutation();
  const [remove] = useDeleteInsightMutation();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(item.text);

  React.useEffect(() => {
    if (!editing) setDraft(item.text);
  }, [item.text, editing]);

  async function save() {
    const text = draft.trim();
    if (!text || text === item.text) {
      setDraft(item.text);
      setEditing(false);
      return;
    }
    try {
      await update({ id: item.id, meetingId, text }).unwrap();
      setEditing(false);
    } catch {
      toast.error("Couldn't save that change.");
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={draft}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setDraft(item.text);
              setEditing(false);
            }
          }}
          className="h-8 border-edge bg-surface-raised text-callout"
        />
        <Button size="icon" variant="ghost" aria-label="Save" onClick={save} disabled={saving}>
          <Check className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    /* A rule and text, not a bordered box. Each of these is one sentence read
       out of the brief above it, so a card around every one turns a short list
       into a stack of objects. */
    <div className="group v2-note flex items-start gap-2" data-tone="quiet">
      <span className="v2-read min-w-0 flex-1">
        {item.text}
        {/* Which section it came from: "Blockers" and "Risks" both store as
            RISK, and losing the distinction loses the difference between what
            is already happening and what might. */}
        {item.sourceSection && item.sourceSection !== "decisions" && (
          <span className="ml-2 font-sans text-cap uppercase text-ink-4">
            {sectionLabel(item.sourceSection)}
          </span>
        )}
      </span>
      <div
        className={cn(
          "no-print flex shrink-0 items-center gap-0.5",
          "opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
        )}
      >
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          aria-label="Edit"
          onClick={() => setEditing(true)}
        >
          <Pencil className="h-3 w-3" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          aria-label="Remove"
          onClick={() => remove({ id: item.id, meetingId })}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

const SECTION_LABELS: Record<string, string> = {
  blockers: "blocker",
  concerns: "client concern",
  risks: "risk",
  selected: "selected idea",
  improvements: "improvement",
};

function sectionLabel(key: string): string {
  return SECTION_LABELS[key] ?? key;
}
