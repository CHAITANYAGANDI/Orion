import type { MeetingStatus } from "@/lib/types";

export function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * A running clock: `0:09`, `12:34`, `1:02:03`.
 *
 * Distinct from {@link formatDuration}, which describes a length after the
 * fact — "1m 30s" reads well in a list of finished meetings and badly on a
 * timer, where the digits should sit still and only the last one move. More to
 * the point, `formatDuration(0)` is "—", so a stopwatch built on it would open
 * on a dash and stay there for a second: the one second in which somebody is
 * looking to see whether pressing Record did anything.
 */
export function stopwatch(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

export function formatDuration(seconds?: number | null): string {
  if (seconds == null || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Convert transcript segment timecode (seconds) to mm:ss. */
export function timecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const STATUS_ORDER: MeetingStatus[] = [
  "UPLOADED",
  "QUEUED",
  "TRANSCRIBING",
  "SUMMARIZING",
  "EXTRACTING",
  "READY",
];

export function statusProgress(status: MeetingStatus): number {
  switch (status) {
    case "CREATED":
      return 5;
    case "UPLOADED":
      return 15;
    case "QUEUED":
      return 25;
    case "TRANSCRIBING":
      return 45;
    case "SUMMARIZING":
      return 65;
    case "EXTRACTING":
      return 85;
    case "READY":
      return 100;
    case "FAILED":
      return 100;
    default:
      return 0;
  }
}

export function statusLabel(status: MeetingStatus): string {
  const map: Record<MeetingStatus, string> = {
    CREATED: "Created",
    UPLOADED: "Uploaded",
    // "Processing", not "Queued". Queued is a fact about our worker pool and
    // reads as "nothing is happening yet"; from outside, the moment a meeting
    // is accepted the work has started. The processing card appends its own
    // ellipsis, so this must not carry one.
    QUEUED: "Processing",
    TRANSCRIBING: "Transcribing",
    SUMMARIZING: "Summarizing",
    EXTRACTING: "Extracting insights",
    READY: "Ready",
    FAILED: "Failed",
  };
  return map[status] ?? status;
}

export function isTerminal(status: MeetingStatus): boolean {
  return status === "READY" || status === "FAILED";
}
