"use client";

/**
 * Templates — the shapes a set of notes can be written in.
 *
 * Read-only, and deliberately so for now: a template is a prompt the ai-service
 * owns, and offering an editor here would be offering to write half a prompt
 * with no way to see what the other half does to the output. What this tab is
 * for is the question people actually have — "what do I get if I pick this one"
 * — which the section headings answer exactly, because they are what the
 * summary will literally contain.
 *
 * The template is chosen per meeting, not globally: a standup and a customer
 * call want different notes, and a workspace default would be wrong for one of
 * them every time.
 */

import { FileText, Loader2 } from "lucide-react";
import Link from "next/link";
import { useGetSummaryTemplatesQuery } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function TemplatesTab() {
  const { data, isLoading } = useGetSummaryTemplatesQuery();
  const templates = data ?? [];

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        How a meeting&apos;s notes are structured. Chosen per meeting — on the
        upload page as it arrives, or from a meeting&apos;s summary afterwards,
        which rewrites the notes without re-transcribing the audio.
      </p>

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading templates…
        </p>
      ) : templates.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No templates are available. The AI service reports the list, so this
            is empty when it cannot be reached.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {templates.map((template) => (
            <Card key={template.slug}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-4 w-4 text-primary" />
                  {template.name}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {template.sectionTitles.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    A single narrative summary, with no fixed headings.
                  </p>
                ) : (
                  <>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Sections
                    </p>
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {template.sectionTitles.map((title) => (
                        <li key={title}>{title}</li>
                      ))}
                    </ul>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Rewriting a meeting under a different template reuses its transcript, so
        it costs one model call rather than a full reprocess — and leaves the
        action items alone, since those are facts about the meeting rather than a
        choice of layout. Do it from{" "}
        <Link href="/home" className="underline underline-offset-2">
          any meeting
        </Link>
        .
      </p>
    </div>
  );
}
