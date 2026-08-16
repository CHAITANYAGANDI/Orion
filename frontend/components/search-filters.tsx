"use client";

import * as React from "react";
import { SlidersHorizontal, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { statusLabel } from "@/lib/format";
import {
  DATE_PRESETS,
  UNFILED_PROJECT,
  activeFilterCount,
  clearFilters,
} from "@/lib/search";
import type { SearchState } from "@/lib/search";
import type { MeetingStatus, Project, SearchFacets } from "@/lib/types";

/**
 * The filter bar.
 *
 * <p>Every dropdown here is populated from the workspace rather than from a
 * constant: the speakers are the names in your transcripts, the owners are the
 * names on your commitments, the tags are the tags you have used. A filter that
 * offers values you do not have is a filter that returns nothing and looks
 * broken, and one that makes you type a name is a filter you have to spell the
 * way the transcript spells it. A facet with nothing in it is not rendered at
 * all — an empty dropdown is a dead control.
 */

/** Radix rejects an empty item value, so absence needs a name of its own. */
const ANY = "__any";

interface Props {
  state: SearchState;
  facets?: SearchFacets;
  /** Template slug → display name, so "one-on-one" reads as "1:1". */
  typeLabels?: Record<string, string>;
  projects?: Project[];
  onChange: (next: SearchState) => void;
}

export function SearchFilters({
  state,
  facets,
  typeLabels,
  projects = [],
  onChange,
}: Props) {
  const active = activeFilterCount(state);
  const set = <K extends keyof SearchState>(key: K, value: SearchState[K]) =>
    onChange({ ...state, [key]: value });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <SlidersHorizontal className="h-3.5 w-3.5" />
        Filters
      </span>

      <FacetSelect
        label="Date"
        value={state.date}
        options={DATE_PRESETS.map((d) => ({ value: d.value, label: d.label }))}
        anyLabel="Any time"
        // The date preset already has a name for "no bound", so it never shows
        // the sentinel row.
        includeAny={false}
        onChange={(v) => set("date", v as SearchState["date"])}
      />

      <FacetSelect
        label="Speaker"
        value={state.speaker}
        options={(facets?.speakers ?? []).map((s) => ({ value: s, label: s }))}
        anyLabel="Anyone"
        onChange={(v) => set("speaker", v)}
      />

      <FacetSelect
        label="Meeting type"
        value={state.type}
        options={(facets?.types ?? []).map((t) => ({
          value: t,
          label: typeLabels?.[t] ?? t,
        }))}
        anyLabel="Any type"
        onChange={(v) => set("type", v)}
      />

      <FacetSelect
        label="Tag"
        value={state.tag}
        options={(facets?.tags ?? []).map((t) => ({ value: t, label: t }))}
        anyLabel="Any tag"
        onChange={(v) => set("tag", v)}
      />

      {/* Projects come from their own endpoint rather than from the search
          facets: a facet is a list of strings, and a project needs its id as
          well as its name. "Unfiled" is an option, not an absence — "what have
          I not sorted yet" is a real search. */}
      <FacetSelect
        label="Project"
        value={state.project}
        options={[
          ...projects.map((p) => ({ value: p.id, label: p.name })),
          ...(projects.length > 0
            ? [{ value: UNFILED_PROJECT, label: "Unfiled" }]
            : []),
        ]}
        anyLabel="Any project"
        onChange={(v) => set("project", v)}
      />

      <FacetSelect
        label="Status"
        value={state.status}
        options={(facets?.statuses ?? []).map((s) => ({
          value: s,
          label: statusLabel(s as MeetingStatus),
        }))}
        anyLabel="Any status"
        onChange={(v) => set("status", v)}
      />

      <FacetSelect
        label="Action owner"
        value={state.owner}
        options={(facets?.owners ?? []).map((o) => ({ value: o, label: o }))}
        anyLabel="Anyone"
        onChange={(v) => set("owner", v)}
      />

      {/* Not "has a decision matching your search" — that is the Decisions
          group. This narrows to meetings that settled something at all, which
          is how you find the conversations that went somewhere. */}
      <button
        type="button"
        aria-pressed={state.withDecisions}
        onClick={() => set("withDecisions", !state.withDecisions)}
        className={cn(
          "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
          state.withDecisions
            ? "border-primary bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        )}
      >
        Settled a decision
      </button>

      {active > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 text-xs text-muted-foreground"
          onClick={() => onChange(clearFilters(state))}
        >
          <X className="h-3 w-3" />
          Clear {active} filter{active === 1 ? "" : "s"}
        </Button>
      )}
    </div>
  );
}

function FacetSelect({
  label,
  value,
  options,
  anyLabel,
  includeAny = true,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  anyLabel: string;
  includeAny?: boolean;
  onChange: (value: string) => void;
}) {
  // Nothing to choose between: the workspace has no speakers named yet, or no
  // commitments with owners. A dropdown with one dead row invites a click that
  // does nothing.
  if (options.length === 0) return null;

  const active = value !== "" && value !== "any";

  return (
    <Select
      value={value === "" ? ANY : value}
      onValueChange={(v) => onChange(v === ANY ? "" : v)}
    >
      <SelectTrigger
        aria-label={label}
        className={cn(
          "h-8 w-auto gap-1 px-3 text-xs",
          active && "border-primary text-primary",
        )}
      >
        <SelectValue placeholder={anyLabel} />
      </SelectTrigger>
      <SelectContent>
        {includeAny && <SelectItem value={ANY}>{anyLabel}</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
