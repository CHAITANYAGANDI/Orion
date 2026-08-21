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
import {
  DATE_PRESETS,
  UNFILED_PROJECT,
  activeFilterCount,
  clearFilters,
} from "@/lib/search";
import type { SearchState } from "@/lib/search";
import type { Project, SearchFacets } from "@/lib/types";

/**
 * The filter bar.
 *
 * <p>Four, and every one of them is populated from the workspace rather than
 * from a constant: the tags are the tags you have used, the folders are your
 * folders, the meeting types are the templates you have. A filter that offers
 * values you do not have is a filter that returns nothing and looks broken, and
 * one that makes you type a name is a filter you have to spell the way the
 * transcript spells it. A facet with nothing in it is not rendered at all — an
 * empty dropdown is a dead control.
 *
 * <p>Speaker, status, action owner and "settled a decision" used to be here.
 * Owner and decisions narrowed lists the results page no longer shows, so they
 * had become controls that could not change what was on screen; speaker and
 * status went with them, because eight dropdowns above two kinds of result is a
 * filter bar wider than its answer. The four left are the ones people reach
 * for. See lib/search.ts, which no longer has the state to hold the others.
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
          well as its name. "No folder" is an option, not an absence — "what
          have I not sorted yet" is a real search. */}
      <FacetSelect
        label="Project"
        value={state.project}
        options={[
          ...projects.map((p) => ({ value: p.id, label: p.name })),
          ...(projects.length > 0
            ? [{ value: UNFILED_PROJECT, label: "No folder" }]
            : []),
        ]}
        anyLabel="Any project"
        onChange={(v) => set("project", v)}
      />

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
