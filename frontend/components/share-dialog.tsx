"use client";

/**
 * Create, configure and revoke a meeting's public links.
 *
 * <p>The link is a capability URL — anyone holding it can read what it reveals —
 * so the dialog is explicit about that, and everything beyond the written
 * summary is opt-in rather than included by default.
 *
 * <p><b>There are no roles here.</b> Viewer, commenter and editor describe what
 * a person may do, which presumes an account to attribute the writing to and to
 * check on the next request. Everyone holding a link is the same anonymous
 * reader, so what varies is not permission but content: four switches saying
 * what is visible, rather than a dropdown implying a person who is not there.
 */

import * as React from "react";
import { toast } from "sonner";
import {
  Share2,
  Copy,
  Check,
  Trash2,
  Loader2,
  Eye,
  Link2,
  Lock,
  Mail,
  Scissors,
  Clock,
} from "lucide-react";
import {
  useGetShareLinksQuery,
  useCreateShareMutation,
  useRevokeShareMutation,
  useRevokeShareLinkMutation,
  useEmailShareMutation,
  useGetMomentsQuery,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime, timecode } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ShareCreateRequest, ShareResponse } from "@/lib/types";

/** Expiry presets. "Never" is a value, not the absence of one — see the API. */
const EXPIRY = [
  { value: "never", label: "Never expires" },
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

export function ShareDialog({ meetingId }: { meetingId: string }) {
  const [open, setOpen] = React.useState(false);
  const { data: links, isLoading } = useGetShareLinksQuery(meetingId, { skip: !open });
  const [createShare, { isLoading: saving }] = useCreateShareMutation();
  const [revokeShare, { isLoading: revoking }] = useRevokeShareMutation();

  const meetingLink = links?.find((l) => l.startSeconds == null);
  const momentLinks = links?.filter((l) => l.startSeconds != null) ?? [];

  async function update(body: ShareCreateRequest) {
    try {
      await createShare({ id: meetingId, body }).unwrap();
    } catch {
      toast.error("Couldn't update the link.");
    }
  }

  async function onRevoke() {
    try {
      await revokeShare(meetingId).unwrap();
      toast.success("Link revoked — it no longer opens.");
    } catch {
      toast.error("Couldn't revoke the link.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Share2 className="h-4 w-4" /> Share
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share this meeting</DialogTitle>
          <DialogDescription>
            A read-only link. Anyone holding it can see what you choose below —
            no Recallix account needed — until you revoke it.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking…
          </div>
        ) : meetingLink ? (
          <div className="space-y-5">
            <LinkRow share={meetingLink} />
            <Contents share={meetingLink} onChange={update} busy={saving} />
            <Expiry share={meetingLink} onChange={update} busy={saving} />
            <Password share={meetingLink} onChange={update} busy={saving} />
            <EmailLink meetingId={meetingId} />
            <MomentLinks
              meetingId={meetingId}
              links={momentLinks}
              onCreate={update}
              busy={saving}
            />

            <Button
              variant="outline"
              onClick={onRevoke}
              disabled={revoking}
              className="w-full gap-2 text-destructive"
            >
              {revoking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Revoke link
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              The summary and action items are shared by default. The transcript
              and the recording are not — you can turn them on once the link
              exists.
            </p>
            <Button onClick={() => void update({})} disabled={saving} className="w-full gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              Create share link
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- pieces ---------------------------------------------------------------- //

function LinkRow({ share }: { share: ShareResponse }) {
  const [copied, setCopied] = React.useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Couldn't copy — select the link and copy manually.");
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={share.url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Share link"
          className="flex-1 rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs"
        />
        <Button size="icon" variant="outline" onClick={onCopy} aria-label="Copy link">
          {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Eye className="h-3.5 w-3.5" />
          {share.viewCount} view{share.viewCount === 1 ? "" : "s"}
        </span>
        {share.lastViewedAt && <span>last {formatDateTime(share.lastViewedAt)}</span>}
        {share.expiresAt && (
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" /> until {formatDateTime(share.expiresAt)}
          </span>
        )}
        {share.passwordProtected && (
          <span className="inline-flex items-center gap-1">
            <Lock className="h-3.5 w-3.5" /> password
          </span>
        )}
      </div>
    </div>
  );
}

/** The four dials. What is visible, not who may act. */
function Contents({
  share,
  onChange,
  busy,
}: {
  share: ShareResponse;
  onChange: (body: ShareCreateRequest) => void;
  busy: boolean;
}) {
  const rows: { key: keyof ShareCreateRequest; label: string; hint: string; on: boolean }[] = [
    {
      key: "includeSummary",
      label: "Summary",
      hint: "The written account of what happened.",
      on: share.includeSummary,
    },
    {
      key: "includeActionItems",
      label: "Action items",
      hint: "Tasks, owners and due dates.",
      on: share.includeActionItems,
    },
    {
      key: "includeTranscript",
      label: "Full transcript",
      hint: "Every word as it was said.",
      on: share.includeTranscript,
    },
    {
      key: "includeAudio",
      label: "Recording",
      hint: "Everyone's actual voice, including what nobody would write down.",
      on: share.includeAudio,
    },
  ];

  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        What the link shows
      </legend>
      {rows.map((r) => (
        <label key={r.key} className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={r.on}
            disabled={busy}
            onChange={(e) => onChange({ [r.key]: e.target.checked })}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
          />
          <span>
            {r.label}
            <span className="block text-xs text-muted-foreground">{r.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function Expiry({
  share,
  onChange,
  busy,
}: {
  share: ShareResponse;
  onChange: (body: ShareCreateRequest) => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="text-sm">
        Expires
        <span className="block text-xs text-muted-foreground">
          A link that outlives its reason is the one that leaks.
        </span>
      </div>
      <Select
        value={share.expiresAt ? "custom" : "never"}
        disabled={busy}
        onValueChange={(v) =>
          onChange(v === "never" ? { neverExpires: true } : { expiresInDays: Number(v) })
        }
      >
        <SelectTrigger aria-label="Expires" className="h-8 w-[150px] text-xs">
          <SelectValue>
            {share.expiresAt ? formatDateTime(share.expiresAt) : "Never expires"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {EXPIRY.map((e) => (
            <SelectItem key={e.value} value={e.value}>
              {e.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The second factor for a link that has leaked but not been noticed — the only
 * control that helps after a URL is somewhere it should not be, since revoking
 * requires knowing.
 */
function Password({
  share,
  onChange,
  busy,
}: {
  share: ShareResponse;
  onChange: (body: ShareCreateRequest) => void;
  busy: boolean;
}) {
  const [value, setValue] = React.useState("");
  const [editing, setEditing] = React.useState(false);

  if (share.passwordProtected && !editing) {
    return (
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <Lock className="h-3.5 w-3.5 text-primary" /> Password protected
        </span>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(true)}>
            Change
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-destructive"
            disabled={busy}
            onClick={() => onChange({ removePassword: true })}
          >
            Remove
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-end gap-2">
      <label className="flex-1 text-sm">
        Password
        <span className="mb-1 block text-xs text-muted-foreground">
          Optional. Send it separately — mailed with the link, it protects nothing.
        </span>
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="At least 4 characters"
          aria-label="Share password"
          className="h-8 text-sm"
        />
      </label>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || value.trim().length < 4}
        onClick={() => {
          onChange({ password: value });
          setValue("");
          setEditing(false);
        }}
      >
        Set
      </Button>
    </div>
  );
}

/**
 * Mailing the link.
 *
 * <p>Called "email this link" rather than "invite", because that is what it is:
 * naming an address grants it nothing, and the link works for whoever ends up
 * holding it. Calling it an invitation would be a lie the recipient could not
 * detect and the sender would rely on.
 */
function EmailLink({ meetingId }: { meetingId: string }) {
  const [to, setTo] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [send, { isLoading }] = useEmailShareMutation();

  async function onSend() {
    const addresses = to
      .split(/[,\s]+/)
      .map((a) => a.trim())
      .filter(Boolean);
    if (addresses.length === 0) return;
    try {
      const { sent } = await send({ id: meetingId, body: { to: addresses, message } }).unwrap();
      setTo("");
      setMessage("");
      toast.success(`Sent to ${sent} recipient${sent === 1 ? "" : "s"}.`);
    } catch {
      toast.error("Couldn't send that email.");
    }
  }

  return (
    <div className="space-y-2 border-t pt-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Email this link
      </p>
      <Input
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="name@example.com, another@example.com"
        aria-label="Email addresses"
        className="h-8 text-sm"
      />
      <Input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Optional note"
        aria-label="Email note"
        className="h-8 text-sm"
      />
      <Button
        size="sm"
        variant="outline"
        onClick={onSend}
        disabled={isLoading || !to.trim()}
        className="gap-1.5"
      >
        {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
        Send link
      </Button>
      <p className="text-xs text-muted-foreground">
        This sends the link — it does not restrict it to those addresses.
      </p>
    </div>
  );
}

/**
 * Links to one moment.
 *
 * <p>Built from marks the user already made rather than from a free-form range:
 * a highlight is a passage somebody has already decided is worth pointing at,
 * and it carries its own quote, so the link keeps showing what was shared even
 * after a reprocess replaces the segments underneath it.
 */
function MomentLinks({
  meetingId,
  links,
  onCreate,
  busy,
}: {
  meetingId: string;
  links: ShareResponse[];
  onCreate: (body: ShareCreateRequest) => void;
  busy: boolean;
}) {
  const { data: moments } = useGetMomentsQuery(meetingId);
  const [revokeOne] = useRevokeShareLinkMutation();

  const shareable = (moments ?? []).filter((m) => m.endSeconds > m.startSeconds);

  if (shareable.length === 0 && links.length === 0) return null;

  return (
    <div className="space-y-2 border-t pt-4">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Scissors className="h-3.5 w-3.5" /> Share one moment
      </p>

      {links.map((l) => (
        <div key={l.id} className="rounded-md border p-2 text-xs">
          <p className="mb-1 line-clamp-2 italic text-muted-foreground">“{l.quote}”</p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={l.url}
              onFocus={(e) => e.currentTarget.select()}
              aria-label={`Link to moment at ${timecode(l.startSeconds ?? 0)}`}
              className="flex-1 rounded border bg-muted/40 px-2 py-1 font-mono text-[11px]"
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-destructive"
              onClick={() => void revokeOne({ shareId: l.id, meetingId })}
            >
              Revoke
            </Button>
          </div>
        </div>
      ))}

      {shareable.slice(0, 5).map((m) => {
        const already = links.some(
          (l) => l.startSeconds === m.startSeconds && l.endSeconds === m.endSeconds,
        );
        if (already) return null;
        return (
          <div key={m.id} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {timecode(m.startSeconds)} · “{m.quote}”
            </span>
            <Button
              size="sm"
              variant="outline"
              className={cn("h-7 shrink-0 text-xs")}
              disabled={busy}
              onClick={() =>
                onCreate({
                  startSeconds: m.startSeconds,
                  endSeconds: m.endSeconds,
                  quote: m.quote,
                })
              }
            >
              Create link
            </Button>
          </div>
        );
      })}
    </div>
  );
}
