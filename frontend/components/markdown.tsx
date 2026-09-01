"use client";

/**
 * An assistant answer, rendered.
 *
 * Answers used to go through `<p className="whitespace-pre-wrap">`, which is a
 * reasonable default right up until the model has something structured to say.
 * A procedure came back as
 *
 *     ### General next steps
 *     1. **Find the official site**
 *        Search for the event page.
 *
 * and the reader saw the hashes and the asterisks. That is not a cosmetic
 * complaint: a numbered procedure displayed as one run-on paragraph is harder
 * to follow than the same information in prose, so the model writing *better*
 * made the answer read *worse*, and the obvious repair — telling it to stop
 * using markdown — would have thrown away the structure rather than showing it.
 *
 * ## Only assistant text comes through here
 *
 * A user's own question is rendered as plain text by `ChatMessageBubble`, and
 * must stay that way. Prompts are typed, pasted, and dragged in from
 * transcripts; running them through a formatter means somebody who quotes a
 * line beginning with `#` sees a heading, and somebody who pastes a table sees
 * their question rearranged. There is nothing to gain and a whole class of
 * confusion to lose.
 *
 * ## What is safe here, and why
 *
 * - **No raw HTML.** react-markdown does not parse it unless `rehype-raw` is
 *   added, which it is not; `skipHtml` is set as well so a literal `<script>`
 *   in a transcript quote is dropped rather than shown as text. There is no
 *   `dangerouslySetInnerHTML` anywhere in this file.
 * - **URLs are filtered.** The default `urlTransform` passes http, https,
 *   mailto and relative links and drops everything else, so `javascript:` in a
 *   link never reaches an anchor.
 * - **Links leave with `noopener noreferrer`**, and `nofollow` because the
 *   destination is model output rather than anything Reverie vouches for.
 * - **No images.** An answer has no business fetching a remote resource, and an
 *   image tag with a tracking URL in it is the cheapest way to find out that
 *   somebody read their meeting notes.
 *
 * ## Sized for the rail, not for a document
 *
 * This renders in a column about four hundred pixels wide. So `###` is styled
 * at roughly the size of bold body text rather than as a heading — the model is
 * told the same thing in `answering.system_prompt`, and the two agree — and
 * lists indent by just enough to show the hang. Code blocks scroll inside
 * themselves rather than widening the rail, which is the difference between an
 * answer containing a long line and an answer with a horizontal scrollbar under
 * the whole conversation.
 */

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/** Elements an answer has no reason to produce. See the note on images above. */
const DISALLOWED = ["img", "script", "style", "iframe", "form", "input"];

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        // `break-words` and `min-w-0` are what keep a long URL or an unbroken
        // token inside the rail instead of widening it and giving the whole
        // thread a horizontal scrollbar.
        "min-w-0 space-y-2 break-words text-sm leading-relaxed",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={DISALLOWED}
        components={COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/**
 * The house styles.
 *
 * Declared once at module scope rather than inline: react-markdown compares
 * this object by identity, and rebuilding it on every render re-mounts every
 * node in the answer — which loses the text selection of anyone in the middle
 * of copying one.
 */
const COMPONENTS = {
  p: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,

  // Three sizes, all restrained. The model is told `###` is the largest
  // available; h1 and h2 are styled anyway, because a brief is advice and a
  // banner headline inside a chat bubble is worth guarding against.
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="pt-1 text-sm font-semibold text-foreground">{children}</h3>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="pt-1 text-sm font-semibold text-foreground">{children}</h3>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="pt-1 text-sm font-semibold text-foreground">{children}</h3>
  ),
  h4: ({ children }: { children?: React.ReactNode }) => (
    <h4 className="pt-1 text-sm font-semibold text-foreground">{children}</h4>
  ),

  // `space-y-1` rather than a margin per item, so a nested list does not gain
  // the spacing of the list it sits inside.
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="ml-4 list-disc space-y-1 marker:text-muted-foreground">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="ml-4 list-decimal space-y-1 marker:text-muted-foreground">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="pl-0.5 [&>ul]:mt-1 [&>ol]:mt-1">{children}</li>
  ),

  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => <em className="italic">{children}</em>,

  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      target="_blank"
      // noopener/noreferrer for the tab, nofollow because this destination came
      // out of a language model and Reverie is not vouching for it.
      rel="noopener noreferrer nofollow"
      className="underline underline-offset-2 hover:text-primary"
    >
      {children}
    </a>
  ),

  code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
    // react-markdown gives a fenced block a `language-*` class and inline code
    // none. Inline code inside a sentence must not become a block, or a
    // mentioned filename breaks the line it is in.
    const block = /language-/.test(className ?? "");
    if (!block) {
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
      );
    }
    return <code className="font-mono text-xs">{children}</code>;
  },
  pre: ({ children }: { children?: React.ReactNode }) => (
    // The scroll is here and not on the thread: a long line scrolls inside its
    // own block rather than widening the conversation around it.
    <pre className="overflow-x-auto rounded-md bg-muted p-2.5 text-xs">{children}</pre>
  ),

  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-border/60" />,

  // Tables come from remark-gfm. Wrapped in their own scroller for the same
  // reason as `pre` — four columns will not fit a rail, and the answer should
  // not be what discovers that.
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-border px-2 py-1 align-top">{children}</td>
  ),
};
