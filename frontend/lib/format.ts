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
    QUEUED: "Queued",
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
