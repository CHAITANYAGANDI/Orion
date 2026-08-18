"use client";

/**
 * The frame every page sits in.
 *
 * Three regions and a rule about each. The rail on the left is for places —
 * Home, the chat, what you connect to, and the folders you filed things in. The
 * bar across the top is for the two things that create a meeting and the two
 * that find one. Everything else — the plan, the settings, the account itself —
 * lives behind the account button, because none of it is somewhere you go
 * during work.
 *
 * What is deliberately absent: the desktop-app card and the plan upsell that
 * used to sit at the bottom of the rail. A sidebar is navigation; an
 * advertisement in it is a permanent piece of chrome that is never the thing
 * anybody is looking for.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Sparkles, Plug, Menu, Mic, Search, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { RecordingProvider, useRecording } from "@/lib/recording-context";
import { formatDuration } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { NotificationBell } from "@/components/notification-bell";
import { SearchCommand } from "@/components/search-command";
import { ImportDialog } from "@/components/import-dialog";
import { AccountMenu } from "@/components/account-menu";
import { FolderTree } from "@/components/folder-tree";

/**
 * The places.
 *
 * Three, and the shortness is the point: Record, Import and Search were nav
 * items and are now buttons in the top bar, because they are things you do
 * rather than places you are. Action items left the rail entirely — they live
 * beside the chat on Home, where they are read.
 */
const NAV = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/ask", label: "AI Chat", icon: Sparkles },
  { href: "/settings/integrations", label: "Integrations", icon: Plug },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  // The provider wraps the shell, not the other way round, so the recorder
  // outlives every route change inside the app group — and so the header can
  // read it. See lib/recording-context.tsx.
  return (
    <RecordingProvider>
      <AppShellInner>{children}</AppShellInner>
    </RecordingProvider>
  );
}

function AppShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const fullBleed = pathname === "/home" || pathname === "/ask";

  // Ctrl/Cmd-K from anywhere. Bound on the shell rather than on the input so it
  // works while the focus is in a transcript, a chat box or nothing at all.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearching(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <div className="flex">
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r bg-card transition-transform lg:translate-x-0 lg:static lg:z-auto",
            mobileOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex h-16 items-center gap-2 px-5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Mic className="h-4 w-4" />
            </div>
            <span className="font-semibold">Recallix</span>
          </div>

          <AccountMenu />

          <nav className="flex flex-col gap-1 p-3">
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <FolderTree onNavigate={() => setMobileOpen(false)} />
        </aside>

        {mobileOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
        )}

        <div className="flex min-h-screen flex-1 flex-col lg:pl-0">
          <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur lg:px-6">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)}>
              <Menu />
            </Button>

            {/* Not an input. Clicking it opens the real one, which needs the
                whole width of the screen for its suggestions — an inline box
                that grew a dropdown on focus would have to fight the header for
                room and would lose on a laptop. */}
            <button
              type="button"
              onClick={() => setSearching(true)}
              className="flex h-9 max-w-md flex-1 items-center gap-2 rounded-full border bg-card px-4 text-sm text-muted-foreground transition-colors hover:bg-accent"
            >
              <Search className="h-4 w-4 shrink-0" />
              <span className="flex-1 text-left">Ask or search</span>
              <kbd className="hidden rounded border px-1.5 text-[10px] font-medium sm:inline">
                Ctrl K
              </kbd>
            </button>

            <div className="flex flex-1 items-center justify-end gap-2">
              <RecordingIndicator />
              {/* A dialog rather than a route: a file arrives more often than
                  anything else creates a meeting, and it should not cost
                  leaving whatever is on screen. /upload still exists for the
                  fuller form — project, YouTube link — and for direct links. */}
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => setImporting(true)}
              >
                <Upload className="h-4 w-4" />
                <span className="hidden sm:inline">Import</span>
              </Button>
              <Button size="sm" className="gap-2" asChild>
                <Link href="/record">
                  <Mic className="h-4 w-4" />
                  <span className="hidden sm:inline">Record</span>
                </Link>
              </Button>
              <NotificationBell />
              <ThemeToggle />
            </div>
          </header>

          {/* Home and the chat lay out their own full-height panes, so they get
              the viewport unpadded. Everything else is a document and reads
              better in a measured column. */}
          {fullBleed ? (
            <main className="flex-1">{children}</main>
          ) : (
            <main className="flex-1 p-4 lg:p-8">
              <div className="mx-auto w-full max-w-6xl">{children}</div>
            </main>
          )}
        </div>
      </div>

      <SearchCommand open={searching} onOpenChange={setSearching} />
      <ImportDialog open={importing} onOpenChange={setImporting} />
    </div>
  );
}

/**
 * Live recording state, visible from every page.
 *
 * Recording survives navigation, which is only an improvement if you can tell it
 * is still happening — an invisible live microphone is worse than one that
 * stops. Also covers the state after stopping: audio captured but not yet saved
 * is the easiest thing in the app to lose.
 */
function RecordingIndicator() {
  const recorder = useRecording();
  const live = recorder.state === "recording" || recorder.state === "paused";
  const unsaved = recorder.state === "stopped" && recorder.result !== null;

  if (!live && !unsaved) return null;

  const paused = recorder.state === "paused";

  return (
    <Link
      href="/record"
      className={cn(
        "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        unsaved
          ? "border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-400"
          : "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20",
      )}
      title={
        unsaved
          ? "You have a recording that hasn't been saved yet"
          : paused
            ? "Recording paused — click to return"
            : "Recording in progress — click to return"
      }
    >
      <span
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          unsaved ? "bg-amber-500" : "bg-destructive",
          // Only a running recording pulses; a paused or finished one is still,
          // so the dot never implies capture that is not happening.
          recorder.state === "recording" && "animate-pulse",
        )}
      />
      {unsaved ? (
        <span>Unsaved recording</span>
      ) : (
        <>
          <span className="hidden sm:inline">{paused ? "Paused" : "Recording"}</span>
          <span className="font-mono tabular-nums">{formatDuration(recorder.elapsed)}</span>
        </>
      )}
    </Link>
  );
}
