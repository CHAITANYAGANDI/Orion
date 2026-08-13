"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import {
  useCreateVocabularyTermMutation,
  useDeleteVocabularyTermMutation,
  useGetVocabularyQuery,
  useUpdateVocabularyTermMutation,
} from "@/lib/api";
import type { VocabularyCategory, VocabularyTerm } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

/**
 * Custom transcription vocabulary.
 *
 * The four categories are presented separately because they are four different
 * questions to ask a user ("who is in your meetings?" is not "what does your
 * team call things?"), even though all four end up in the same boosting list.
 */
const CATEGORIES: {
  value: VocabularyCategory;
  label: string;
  hint: string;
  placeholder: string;
}[] = [
  {
    value: "NAME",
    label: "Names",
    hint: "People, companies and products the transcriber keeps mangling.",
    placeholder: "Priya Raghunathan",
  },
  {
    value: "JARGON",
    label: "Technical jargon",
    hint: "Domain terms that are not ordinary English.",
    placeholder: "idempotency",
  },
  {
    value: "ACRONYM",
    label: "Acronyms",
    hint: "Letters your team says out loud. Add what they stand for so summaries can use it.",
    placeholder: "SRE",
  },
  {
    value: "KEYWORD",
    label: "Keywords",
    hint: "Anything else worth recognising accurately.",
    placeholder: "Project Northstar",
  },
];

export function VocabularyCard() {
  const vocabulary = useGetVocabularyQuery();
  const [createTerm, { isLoading: creating }] = useCreateVocabularyTermMutation();
  const [updateTerm] = useUpdateVocabularyTermMutation();
  const [deleteTerm] = useDeleteVocabularyTermMutation();

  const [term, setTerm] = React.useState("");
  const [expansion, setExpansion] = React.useState("");
  const [category, setCategory] = React.useState<VocabularyCategory>("NAME");

  const grouped = React.useMemo(() => {
    const map = new Map<VocabularyCategory, VocabularyTerm[]>();
    for (const entry of vocabulary.data ?? []) {
      const list = map.get(entry.category) ?? [];
      list.push(entry);
      map.set(entry.category, list);
    }
    return map;
  }, [vocabulary.data]);

  const active = CATEGORIES.find((c) => c.value === category) ?? CATEGORIES[0];

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = term.trim();
    if (!trimmed) return;
    try {
      await createTerm({
        term: trimmed,
        category,
        expansion: category === "ACRONYM" ? expansion.trim() : undefined,
      }).unwrap();
      setTerm("");
      setExpansion("");
      toast.success(`"${trimmed}" added.`);
    } catch (error) {
      // The server rejects duplicates and the per-user cap with a message worth
      // showing verbatim — "something went wrong" would leave the user retyping
      // a term they already have.
      const detail =
        (error as { data?: { message?: string } })?.data?.message ??
        "Could not add that term.";
      toast.error(detail);
    }
  }

  async function toggle(entry: VocabularyTerm) {
    try {
      await updateTerm({
        id: entry.id,
        term: entry.term,
        category: entry.category,
        expansion: entry.expansion,
        active: !entry.active,
      }).unwrap();
    } catch {
      toast.error("Could not update that term.");
    }
  }

  async function remove(entry: VocabularyTerm) {
    try {
      await deleteTerm(entry.id).unwrap();
      toast.success(`"${entry.term}" removed.`);
    } catch {
      toast.error("Could not remove that term.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Custom vocabulary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Words the transcriber should expect. These make a term more likely to be
          heard correctly — they do not force it. Terms apply to meetings processed
          after you add them; reprocess an existing meeting to apply them to it.
        </p>

        <form onSubmit={add} className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((c) => (
              <Button
                key={c.value}
                type="button"
                size="sm"
                variant={category === c.value ? "default" : "outline"}
                onClick={() => setCategory(c.value)}
              >
                {c.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{active.hint}</p>

          <div className="flex flex-wrap items-end gap-2">
            <div className="grid min-w-[12rem] flex-1 gap-1.5">
              <Label htmlFor="vocabulary-term">Term</Label>
              <Input
                id="vocabulary-term"
                value={term}
                placeholder={active.placeholder}
                maxLength={120}
                onChange={(e) => setTerm(e.target.value)}
              />
            </div>
            {category === "ACRONYM" && (
              <div className="grid min-w-[12rem] flex-1 gap-1.5">
                <Label htmlFor="vocabulary-expansion">Stands for</Label>
                <Input
                  id="vocabulary-expansion"
                  value={expansion}
                  placeholder="site reliability engineering"
                  maxLength={240}
                  onChange={(e) => setExpansion(e.target.value)}
                />
              </div>
            )}
            <Button type="submit" disabled={creating || !term.trim()}>
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Add
            </Button>
          </div>
        </form>

        <div className="space-y-4 border-t pt-4">
          {vocabulary.isLoading && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {!vocabulary.isLoading && (vocabulary.data ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">
              No terms yet. Add the names and jargon your meetings actually use.
            </p>
          )}
          {CATEGORIES.map((c) => {
            const entries = grouped.get(c.value) ?? [];
            if (entries.length === 0) return null;
            return (
              <div key={c.value} className="space-y-2">
                <h4 className="text-sm font-semibold">{c.label}</h4>
                <ul className="space-y-1.5">
                  {entries.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
                    >
                      <span className={entry.active ? "" : "text-muted-foreground line-through"}>
                        {entry.term}
                      </span>
                      {entry.expansion && (
                        <span className="truncate text-xs text-muted-foreground">
                          {entry.expansion}
                        </span>
                      )}
                      {!entry.active && (
                        <Badge variant="secondary" className="text-xs">Off</Badge>
                      )}
                      <div className="ml-auto flex items-center gap-1">
                        {/* Disable rather than delete: a term that caused a bad
                            boost is worth keeping around switched off. */}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => toggle(entry)}
                        >
                          {entry.active ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove ${entry.term}`}
                          onClick={() => remove(entry)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
