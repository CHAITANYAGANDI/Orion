"use client";

/**
 * The workspace tracker.
 *
 * <p>It opens on what is left rather than on everything, because that is the
 * question somebody comes here to ask. The five views are the five ways that
 * question gets asked — what is outstanding, what is late, what lands this week,
 * what is mine, what got done — and each one is a filter the server applies, not
 * a slice of a list fetched whole. That matters for the counts: a tab labelled
 * with a number the list disagrees with is worse than a tab with no number.
 */

import * as React from "react";
import { toast } from "sonner";
import { ListChecks, Loader2 } from "lucide-react";
import {
  useBulkPatchActionItemsMutation,
  useGetActionItemOverviewQuery,
  useGetActionItemsQuery,
  useUpdatePreferencesMutation,
} from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ActionItemRow } from "@/components/action-item-row";
import { NewActionItemDialog } from "@/components/new-action-item-dialog";
import type { ActionItemListQuery, ActionItemOverview, Priority } from "@/lib/types";

type View = "open" | "overdue" | "soon" | "mine" | "done";

/** Each view is a set of query parameters; nothing is filtered in the browser. */
const VIEWS: { value: View; label: string; query: ActionItemListQuery }[] = [
  { value: "open", label: "Open", query: { status: "OPEN_ANY" } },
  { value: "overdue", label: "Overdue", query: { status: "OPEN_ANY", due: "overdue" } },
  { value: "soon", label: "Due soon", query: { status: "OPEN_ANY", due: "soon" } },
  { value: "mine", label: "My tasks", query: { status: "OPEN_ANY", mine: true } },
  { value: "done", label: "Done", query: { status: "DONE" } },
];

const PRIORITIES: { value: string; label: string }[] = [
  { value: "ALL", label: "Any priority" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

export default function ActionItemsPage() {
  const [view, setView] = React.useState<View>("open");
  const [owner, setOwner] = React.useState("ALL");
  const [priority, setPriority] = React.useState("ALL");
  const [selected, setSelected] = React.useState<string[]>([]);

  const overview = useGetActionItemOverviewQuery();
  const counts = overview.data?.counts;

  const base = VIEWS.find((v) => v.value === view)!.query;
  const { data, isLoading, isFetching } = useGetActionItemsQuery({
    ...base,
    // The owner filter is meaningless inside My tasks, which is already one.
    owner: view === "mine" || owner === "ALL" ? undefined : owner,
    priority: priority === "ALL" ? undefined : (priority as Priority),
    size: 100,
  });

  // A selection that outlived the list it was made in would complete rows
  // nobody can see.
  React.useEffect(() => {
    setSelected([]);
  }, [view, owner, priority]);

  const items = data?.content ?? [];
  const needsAName = view === "mine" && overview.data && !overview.data.me;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Action items</h1>
          <p className="text-sm text-muted-foreground">
            Everything promised across your meetings, and what is left of it.
          </p>
        </div>
        <NewActionItemDialog label="New action item" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {VIEWS.map((v) => (
          <Button
            key={v.value}
            size="sm"
            variant={view === v.value ? "default" : "outline"}
            onClick={() => setView(v.value)}
          >
            {v.label}
            {counts && (
              <span
                className={cn(
                  "ml-1.5 font-mono text-xs tabular-nums",
                  view === v.value ? "opacity-80" : "text-muted-foreground",
                )}
              >
                {countFor(v.value, counts)}
              </span>
            )}
          </Button>
        ))}

        <div className="flex-1" />

        {view !== "mine" && (overview.data?.owners.length ?? 0) > 0 && (
          <Select value={owner} onValueChange={setOwner}>
            <SelectTrigger className="w-[170px]" aria-label="Owner">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Anyone</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {overview.data?.owners.map((o) => (
                <SelectItem key={o.name} value={o.name}>
                  {o.name} ({o.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select value={priority} onValueChange={setPriority}>
          <SelectTrigger className="w-[150px]" aria-label="Priority">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRIORITIES.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selected.length > 0 && (
        <BulkBar
          ids={selected}
          reopen={view === "done"}
          onDone={() => setSelected([])}
        />
      )}

      <Card>
        <CardContent className="pt-6">
          {needsAName ? (
            <WhoAmI owners={overview.data?.owners.map((o) => o.name) ?? []} />
          ) : isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : items.length > 0 ? (
            <>
              <SelectAll
                items={items.map((i) => i.id)}
                selected={selected}
                onChange={setSelected}
                busy={isFetching}
              />
              <ul className="divide-y">
                {items.map((item) => (
                  <ActionItemRow
                    key={item.id}
                    item={item}
                    selectable
                    selected={selected.includes(item.id)}
                    onSelectedChange={(on) =>
                      setSelected((prev) =>
                        on ? [...prev, item.id] : prev.filter((id) => id !== item.id),
                      )
                    }
                  />
                ))}
              </ul>
            </>
          ) : (
            <Empty view={view} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function countFor(view: View, counts: ActionItemOverview["counts"]) {
  switch (view) {
    case "open":
      return counts.open;
    case "overdue":
      return counts.overdue;
    case "soon":
      return counts.dueSoon;
    case "mine":
      return counts.mine;
    default:
      return counts.done;
  }
}

function SelectAll({
  items,
  selected,
  onChange,
  busy,
}: {
  items: string[];
  selected: string[];
  onChange: (ids: string[]) => void;
  busy: boolean;
}) {
  const all = items.length > 0 && items.every((id) => selected.includes(id));
  return (
    <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
      <input
        type="checkbox"
        checked={all}
        disabled={busy}
        aria-label="Select all"
        onChange={(e) => onChange(e.target.checked ? items : [])}
        className="h-4 w-4 accent-[hsl(var(--muted-foreground))]"
      />
      Select all
    </label>
  );
}

/**
 * What you can do to a selection.
 *
 * Only status, and only in the one direction the current view implies. Bulk
 * editing owners or deadlines sounds obvious and is how somebody reassigns
 * fifteen tasks with one mis-click; completing is the operation people actually
 * do in batches, and it is reversible.
 */
function BulkBar({
  ids,
  reopen,
  onDone,
}: {
  ids: string[];
  reopen: boolean;
  onDone: () => void;
}) {
  const [bulk, { isLoading }] = useBulkPatchActionItemsMutation();

  async function apply(status: "DONE" | "OPEN") {
    try {
      const { changed } = await bulk({ ids, status }).unwrap();
      toast.success(
        changed === 1
          ? status === "DONE"
            ? "1 action item completed."
            : "1 action item reopened."
          : `${changed} action items ${status === "DONE" ? "completed" : "reopened"}.`,
      );
      onDone();
    } catch {
      toast.error("Could not update those.");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <span className="font-medium">{ids.length} selected</span>
      <div className="flex-1" />
      {reopen ? (
        <Button size="sm" variant="outline" disabled={isLoading} onClick={() => apply("OPEN")}>
          {isLoading && <Loader2 className="h-4 w-4 animate-spin" />} Reopen
        </Button>
      ) : (
        <Button size="sm" disabled={isLoading} onClick={() => apply("DONE")}>
          {isLoading && <Loader2 className="h-4 w-4 animate-spin" />} Mark complete
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onDone}>
        Clear
      </Button>
    </div>
  );
}

/**
 * Asked once, when My tasks is first opened.
 *
 * Nothing joins an account to a transcript — the account has an email, the
 * transcript has "Priya" — so this cannot be inferred and has to be asked. It is
 * asked as a pick from the names already assigned work here rather than as a
 * text box, because a name typed differently from the way the transcript spells
 * it produces an empty list and no explanation for it.
 */
function WhoAmI({ owners }: { owners: string[] }) {
  const [update, { isLoading }] = useUpdatePreferencesMutation();

  async function pick(name: string) {
    try {
      await update({ displayName: name }).unwrap();
    } catch {
      toast.error("Could not save that.");
    }
  }

  return (
    <div className="py-6 text-center">
      <p className="font-medium">Which of these is you?</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Action items are assigned to the names spoken in your meetings. Tell
        Recallix which one is yours and this becomes your list.
      </p>
      {owners.length > 0 ? (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {owners.map((name) => (
            <Button key={name} variant="outline" size="sm" disabled={isLoading} onClick={() => pick(name)}>
              {name}
            </Button>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          Nothing is assigned to anybody yet. Set your name in Settings.
        </p>
      )}
    </div>
  );
}

function Empty({ view }: { view: View }) {
  const message: Record<View, string> = {
    open: "Nothing outstanding. Process a meeting to see what gets promised.",
    overdue: "Nothing is late.",
    soon: "Nothing falls due in the next few days.",
    mine: "Nothing is assigned to you right now.",
    done: "Nothing has been completed yet.",
  };
  return (
    <div className="flex flex-col items-center py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <ListChecks className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="mt-3 font-medium">Nothing here</p>
      <p className="text-sm text-muted-foreground">{message[view]}</p>
    </div>
  );
}
