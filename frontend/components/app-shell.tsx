"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Upload,
  Search,
  ListChecks,
  CreditCard,
  Settings as SettingsIcon,
  Menu,
  Mic,
  LogOut,
  Sparkles,
  FolderOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { RecordingProvider, useRecording } from "@/lib/recording-context";
import { formatDuration } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { NotificationBell } from "@/components/notification-bell";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/record", label: "Record meeting", icon: Mic },
  { href: "/upload", label: "Upload meeting", icon: Upload },
  { href: "/ask", label: "Ask Recallix", icon: Sparkles },
  { href: "/projects", label: "Projects", icon: FolderOpen },
  // Not "Search meetings" any more: it searches people, decisions, commitments
  // and every sentence anyone said, and a label that promises less than the
  // page does is a feature nobody finds.
  { href: "/search", label: "Search", icon: Search },
  { href: "/action-items", label: "Action items", icon: ListChecks },
  { href: "/billing", label: "Billing", icon: CreditCard },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
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

  return (
    <div className="min-h-screen bg-background">
      <div className="flex">
        {/* Sidebar */}
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-40 w-64 border-r bg-card transition-transform lg:translate-x-0 lg:static lg:z-auto",
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          <div className="flex h-16 items-center gap-2 border-b px-5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Mic className="h-4 w-4" />
            </div>
            <span className="font-semibold">Recallix AI</span>
          </div>
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
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        {mobileOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
        )}

        {/* Main */}
        <div className="flex min-h-screen flex-1 flex-col lg:pl-0">
          <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-background/80 px-4 backdrop-blur lg:px-8">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)}>
              <Menu />
            </Button>
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              <RecordingIndicator />
              <NotificationBell />
              <ThemeToggle />
              <UserMenu />
            </div>
          </header>
          <main className="flex-1 p-4 lg:p-8">
            <div className="mx-auto w-full max-w-6xl">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}

/**
 * Live recording state, visible from every page.
 *
 * Recording now survives navigation, which is only an improvement if you can
 * tell it is still happening — an invisible live microphone is worse than one
 * that stops. Shows the running clock, and links back to the record page so
 * there is always one click between you and the stop button.
 *
 * Also covers the state after stopping: audio captured but not yet saved is the
 * easiest thing in the app to lose, so it keeps nagging until it is dealt with.
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
          : "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20"
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
          recorder.state === "recording" && "animate-pulse"
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

function UserMenu() {
  const { userId, mode, setDevUserId, signOut } = useAuth();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
            {userId?.slice(-2).toUpperCase() || "ME"}
          </span>
          <span className="max-w-[120px] truncate">{userId || "user"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate">{userId}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {mode === "dev" ? (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              const next = window.prompt("Switch dev user id", userId);
              if (next) setDevUserId(next);
            }}
          >
            Switch dev user
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => signOut?.()}>
            <LogOut className="mr-1" /> Sign out
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
