"use client";

/**
 * Privacy & data.
 *
 * The page somebody opens when they stop and think about what a meeting
 * recorder has of theirs. It answers four questions in the order they get
 * asked: what do you have, who else can see it, how long will you keep it, and
 * how do I leave.
 *
 * Two rules shaped it. Nothing here is a claim we cannot back — every number is
 * a count of real rows and the encryption line is read back from the object
 * store, which is allowed to say no. And the irreversible things are described
 * before they are offered, in the sentence next to the button rather than in a
 * dialog that appears after the decision has been made.
 */

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ShieldCheck,
  Database,
  Link2,
  Clock,
  Download,
  Trash2,
  Lock,
  KeyRound,
  AlertTriangle,
  Loader2,
  ExternalLink,
  Bot,
} from "lucide-react";
import {
  useGetPrivacyOverviewQuery,
  useUpdateRetentionMutation,
  useRevokeAllLinksMutation,
  useCloseAccountMutation,
} from "@/lib/api";
import { downloadAccountArchive } from "@/lib/exports";
import {
  RETENTION_CHOICES,
  DELETE_PHRASE,
  confirmsDeletion,
  privacyError,
} from "@/lib/privacy";
import { useAuth } from "@/lib/auth";
import type { LiveLink, RetentionPolicy } from "@/lib/types";
import { formatDate, formatDateTime } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function PrivacyPage() {
  const overview = useGetPrivacyOverviewQuery();

  if (overview.isLoading) {
    return (
      <div className="max-w-3xl space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!overview.data) {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn&apos;t load your data. Reload the page to try again.
      </p>
    );
  }

  const { held, retention, storage, liveLinks } = overview.data;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ShieldCheck className="h-6 w-6 text-primary" /> Privacy &amp; data
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What Recallix holds, who can see it, how long it stays, and how to take
          it all with you or make it stop.
        </p>
      </div>

      {/* 1. What is here */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4 text-primary" /> What Recallix has
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Meetings" value={held.meetings} />
            <Stat label="Recordings" value={held.recordings} />
            <Stat label="Transcripts" value={held.transcripts} />
            <Stat label="Action items" value={held.actionItems} />
            <Stat label="Highlights & notes" value={held.marks} />
            <Stat label="Projects" value={held.projects} />
            <Stat label="AI conversations" value={held.chats} />
            <Stat
              label="Oldest"
              value={held.oldestMeetingAt ? formatDate(held.oldestMeetingAt) : "—"}
            />
          </dl>

          {(held.audioErased > 0 || held.transcriptsErased > 0) && (
            <p className="text-xs text-muted-foreground">
              You have erased{" "}
              {held.audioErased > 0 && (
                <strong>
                  {held.audioErased} recording{held.audioErased === 1 ? "" : "s"}
                </strong>
              )}
              {held.audioErased > 0 && held.transcriptsErased > 0 && " and "}
              {held.transcriptsErased > 0 && (
                <strong>
                  {held.transcriptsErased} transcript
                  {held.transcriptsErased === 1 ? "" : "s"}
                </strong>
              )}
              . Those meetings are still listed — what was deleted is gone from them.
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            {held.consentConfirmed > 0 ? (
              <>
                {held.consentConfirmed} of these were recorded here, with the person
                recording confirming they had told the room. Everything else was
                uploaded or imported, where Recallix was not present to ask.
              </>
            ) : (
              <>
                Nothing here was recorded in Recallix — these were all uploaded or
                imported, so there was no moment at which Recallix could ask about
                consent.
              </>
            )}
          </p>
        </CardContent>
      </Card>

      {/* 2. How it is kept */}
      <StorageCard storage={storage} />

      {/* 3. Who else can see it */}
      <LinksCard links={liveLinks} />

      {/* 4. How long */}
      <RetentionCard retention={retention} />

      {/* 5. Taking it away */}
      <ExportCard meetings={held.meetings} />

      <CloseAccountCard held={held.meetings} recordings={held.recordings} />
    </div>
  );
}

/* ------------------------------- the sections ----------------------------- */

/**
 * How the recordings are stored.
 *
 * Three lines are properties of the code and always true. The fourth is a
 * property of the deployment, read back from the bucket, and is allowed to say
 * "not configured" — which is exactly what a local docker-compose will say, and
 * is worth seeing rather than papering over.
 */
function StorageCard({ storage }: { storage: { encryptionAtRest: string | null; signedUrlSeconds: number; rowLevelSecurity: boolean } }) {
  const minutes = Math.round(storage.signedUrlSeconds / 60);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Lock className="h-4 w-4 text-primary" /> How it is stored
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <Fact ok>
          Recordings live in a private bucket. Nothing in it is readable by URL.
        </Fact>
        <Fact ok>
          Playing or downloading one uses a link Recallix signs for you, which stops
          working after {minutes} minute{minutes === 1 ? "" : "s"}.
        </Fact>
        <Fact ok={storage.rowLevelSecurity}>
          Every table enforces row-level security in the database, so one account
          cannot read another&apos;s rows even if the application asks it to.
        </Fact>
        <Fact ok={Boolean(storage.encryptionAtRest)}>
          {storage.encryptionAtRest ? (
            <>
              The bucket encrypts everything it stores (
              <code className="rounded bg-muted px-1 text-xs">
                {storage.encryptionAtRest}
              </code>
              ).
            </>
          ) : (
            <>
              This bucket applies no encryption at rest. That is a setting on the
              storage itself, not something the app can claim on its behalf.
            </>
          )}
        </Fact>
        <p className="flex items-start gap-2 pt-1 text-xs text-muted-foreground">
          <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Recallix has no bot. It never joins a call, never appears in a
          participant list and cannot record anything you have not handed it —
          recording happens in your own browser tab, or from a file you upload.
        </p>
      </CardContent>
    </Card>
  );
}

/** Every link a stranger holding the URL could open right now. */
function LinksCard({ links }: { links: LiveLink[] }) {
  const [revokeAll, { isLoading }] = useRevokeAllLinksMutation();
  const [confirming, setConfirming] = React.useState(false);

  async function onRevokeAll() {
    try {
      const { revoked } = await revokeAll().unwrap();
      toast.success(
        revoked === 1 ? "1 link withdrawn." : `${revoked} links withdrawn.`,
      );
      setConfirming(false);
    } catch {
      toast.error("Couldn't withdraw those links.");
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="h-4 w-4 text-primary" /> Shared links
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {links.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing is shared. Meetings are private until you publish a link, and
            no link exists right now.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {links.length} link{links.length === 1 ? "" : "s"} can be opened by
              anyone who has the URL.
            </p>
            <ul className="space-y-2">
              {links.map((link) => (
                <LinkRow key={link.id} link={link} />
              ))}
            </ul>
            {confirming ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                <p className="flex-1 text-sm">
                  Withdraw all {links.length}? Anyone holding one stops being able
                  to open it. You can share again afterwards.
                </p>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={isLoading}
                  onClick={() => void onRevokeAll()}
                >
                  {isLoading && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                  Withdraw all
                </Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
                Withdraw every link
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LinkRow({ link }: { link: LiveLink }) {
  return (
    <li className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/meetings/${link.meetingId}`}
          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
        >
          {link.meetingTitle}
        </Link>
        {link.moment && <Badge variant="secondary">excerpt</Badge>}
        {link.passwordProtected && (
          <Badge variant="secondary" className="gap-1">
            <KeyRound className="h-3 w-3" /> password
          </Badge>
        )}
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-muted-foreground hover:text-primary"
          aria-label={`Open the shared link for ${link.meetingTitle}`}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Shows {link.reveals.join(", ")} ·{" "}
        {link.viewCount === 0
          ? "never opened"
          : `opened ${link.viewCount} time${link.viewCount === 1 ? "" : "s"}${
              link.lastViewedAt ? `, last ${formatDateTime(link.lastViewedAt)}` : ""
            }`}
        {link.expiresAt ? ` · expires ${formatDate(link.expiresAt)}` : " · no expiry"}
      </p>
    </li>
  );
}

/**
 * The two dials.
 *
 * Saved on selection rather than behind a Save button, because the response
 * carries what the new policy would delete tonight and that number is the whole
 * point of the control. Reading "this would delete 43 recordings" a moment after
 * choosing is what stops somebody picking 7 days by mistake.
 */
function RetentionCard({ retention }: { retention: RetentionPolicy }) {
  const [update, { isLoading }] = useUpdateRetentionMutation();

  async function choose(which: "audio" | "meeting", days: number | null) {
    const next = {
      audioDays: which === "audio" ? days : retention.audioDays,
      meetingDays: which === "meeting" ? days : retention.meetingDays,
    };
    try {
      await update(next).unwrap();
      toast.success("Retention saved.");
    } catch (err) {
      toast.error(privacyError(err));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4 text-primary" /> How long it is kept
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <Dial
          label="Delete recordings after"
          hint="The audio goes; the transcript, summary and action items stay."
          value={retention.audioDays}
          disabled={isLoading}
          onChoose={(days) => void choose("audio", days)}
          dueNow={retention.recordingsDueNow}
          dueNoun="recording"
        />
        <Dial
          label="Delete whole meetings after"
          hint="Everything about the meeting, including its notes."
          value={retention.meetingDays}
          disabled={isLoading}
          onChoose={(days) => void choose("meeting", days)}
          dueNow={retention.meetingsDueNow}
          dueNoun="meeting"
        />
        <p className="text-xs text-muted-foreground">
          Measured from when a meeting was created, not when you last opened it —
          otherwise a recording survives forever precisely because people keep
          going back to it. The pass runs each night, and tells you what it took.
        </p>
      </CardContent>
    </Card>
  );
}

function Dial({
  label,
  hint,
  value,
  disabled,
  onChoose,
  dueNow,
  dueNoun,
}: {
  label: string;
  hint: string;
  value: number | null;
  disabled: boolean;
  onChoose: (days: number | null) => void;
  dueNow: number;
  dueNoun: string;
}) {
  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      <p className="mb-2 text-xs text-muted-foreground">{hint}</p>
      <div className="flex flex-wrap gap-2">
        {RETENTION_CHOICES.map((choice) => (
          <button
            key={String(choice.days)}
            type="button"
            disabled={disabled}
            aria-pressed={value === choice.days}
            onClick={() => onChoose(choice.days)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              value === choice.days
                ? "border-primary bg-primary/10 text-primary"
                : "hover:bg-accent",
              disabled && "cursor-not-allowed opacity-60",
            )}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {dueNow > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Tonight this deletes {dueNow} {dueNoun}
          {dueNow === 1 ? "" : "s"} you already have.
        </p>
      )}
    </div>
  );
}

function ExportCard({ meetings }: { meetings: number }) {
  const [busy, setBusy] = React.useState(false);

  async function onDownload() {
    setBusy(true);
    try {
      await downloadAccountArchive();
      toast.success("Downloaded.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't build the archive.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Download className="h-4 w-4 text-primary" /> Take everything with you
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          A zip containing all {meetings} meeting{meetings === 1 ? "" : "s"} twice
          over: as JSON another system could read, and as Markdown a person can.
          Plus your settings, projects, live links and every action item as a
          spreadsheet.
        </p>
        <p className="text-xs text-muted-foreground">
          The recordings are not in it — an archive of any size is gigabytes of
          audio. Each meeting page downloads its own.
        </p>
        <Button variant="outline" onClick={() => void onDownload()} disabled={busy}>
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          {busy ? "Building…" : "Download my data"}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Closing the account.
 *
 * No grace period and no recycle bin. The alternative — mark it deleted, hold
 * it for thirty days — means answering "yes, that is deleted" while the data is
 * still on disk, which is the answer this page exists to make true. The safety
 * net is the export directly above it, which is why the two sit together.
 */
function CloseAccountCard({ held, recordings }: { held: number; recordings: number }) {
  const { signOut } = useAuth();
  const [close, { isLoading }] = useCloseAccountMutation();
  const [typed, setTyped] = React.useState("");
  const [open, setOpen] = React.useState(false);

  const matches = confirmsDeletion(typed);

  async function onClose() {
    try {
      const result = await close({ confirm: typed }).unwrap();
      toast.success(
        `Deleted ${result.meetings} meeting${result.meetings === 1 ? "" : "s"} and ` +
          `${result.storedObjects} recording${result.storedObjects === 1 ? "" : "s"}.`,
      );
      setOpen(false);
      setTyped("");
      signOut?.();
    } catch (err) {
      toast.error(privacyError(err));
    }
  }

  return (
    <Card className="border-destructive/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-destructive">
          <Trash2 className="h-4 w-4" /> Close this account
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Deletes {held} meeting{held === 1 ? "" : "s"}, {recordings} recording
          {recordings === 1 ? "" : "s"}, and every transcript, summary, action
          item, note, project and conversation with them.{" "}
          <strong className="text-foreground">
            Immediately, and with no way back
          </strong>{" "}
          — nothing is held in a bin, so there is nothing anybody could restore.
          Download your data first.
        </p>

        {open ? (
          <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <label className="block text-sm" htmlFor="confirm-delete">
              Type <strong>{DELETE_PHRASE}</strong> to confirm.
            </label>
            <Input
              id="confirm-delete"
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
              placeholder={DELETE_PHRASE}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  setTyped("");
                }}
              >
                Keep my account
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={!matches || isLoading}
                onClick={() => void onClose()}
              >
                {isLoading && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                Delete everything
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="destructive" onClick={() => setOpen(true)}>
            Close account
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/* --------------------------------- pieces --------------------------------- */

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Fact({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2">
      <span
        aria-hidden
        className={cn(
          "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
          ok ? "bg-emerald-500" : "bg-amber-500",
        )}
      />
      <span className={cn(!ok && "text-muted-foreground")}>{children}</span>
    </p>
  );
}
