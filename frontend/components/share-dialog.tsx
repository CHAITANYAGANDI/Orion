"use client";

/**
 * Create, configure and revoke a meeting's public share link.
 *
 * The link is a capability URL — anyone holding it can read the meeting — so the
 * dialog is explicit about that, and the verbatim transcript is opt-in rather
 * than included by default.
 */

import * as React from "react";
import { toast } from "sonner";
import { Share2, Copy, Check, Trash2, Loader2, Eye, Link2 } from "lucide-react";
import {
  useGetShareQuery,
  useCreateShareMutation,
  useRevokeShareMutation,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatDateTime } from "@/lib/format";

export function ShareDialog({ meetingId }: { meetingId: string }) {
  const [open, setOpen] = React.useState(false);
  const { data: share, isLoading } = useGetShareQuery(meetingId, { skip: !open });
  const [createShare, { isLoading: creating }] = useCreateShareMutation();
  const [revokeShare, { isLoading: revoking }] = useRevokeShareMutation();

  const [includeTranscript, setIncludeTranscript] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  // Reflect the saved setting whenever the dialog loads an existing link.
  React.useEffect(() => {
    if (share) setIncludeTranscript(share.includeTranscript);
  }, [share]);

  async function onCreate() {
    try {
      await createShare({ id: meetingId, body: { includeTranscript } }).unwrap();
      toast.success("Share link ready.");
    } catch {
      toast.error("Couldn't create the link.");
    }
  }

  async function onToggleTranscript(next: boolean) {
    setIncludeTranscript(next);
    if (!share) return;
    try {
      await createShare({ id: meetingId, body: { includeTranscript: next } }).unwrap();
    } catch {
      setIncludeTranscript(!next);
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

  async function onCopy() {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Couldn't copy — select the link and copy manually.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Share2 className="h-4 w-4" /> Share
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share this meeting</DialogTitle>
          <DialogDescription>
            Creates a read-only link. Anyone with it can view the summary — no
            Recallix account needed — until you revoke it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking…
            </div>
          ) : share ? (
            <>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={share.url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs"
                />
                <Button size="icon" variant="outline" onClick={onCopy} aria-label="Copy link">
                  {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>

              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Eye className="h-3.5 w-3.5" />
                  {share.viewCount} view{share.viewCount === 1 ? "" : "s"}
                </span>
                {share.lastViewedAt && <span>last {formatDateTime(share.lastViewedAt)}</span>}
              </div>

              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeTranscript}
                  disabled={creating}
                  onChange={(e) => void onToggleTranscript(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
                />
                <span>
                  Include the full transcript
                  <span className="block text-xs text-muted-foreground">
                    Off by default — a summary is usually safe to forward, a
                    verbatim transcript often isn&apos;t.
                  </span>
                </span>
              </label>

              <Button
                variant="outline"
                onClick={onRevoke}
                disabled={revoking}
                className="w-full gap-2 text-destructive"
              >
                {revoking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Revoke link
              </Button>
            </>
          ) : (
            <>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeTranscript}
                  onChange={(e) => setIncludeTranscript(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
                />
                <span>
                  Include the full transcript
                  <span className="block text-xs text-muted-foreground">
                    Otherwise only the summary, decisions, action items and risks
                    are shared.
                  </span>
                </span>
              </label>

              <Button onClick={onCreate} disabled={creating} className="w-full gap-2">
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                Create share link
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
