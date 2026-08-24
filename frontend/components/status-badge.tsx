import { Badge } from "@/components/ui/badge";
import { statusLabel } from "@/lib/format";
import type { MeetingStatus } from "@/lib/types";

export function StatusBadge({ status }: { status: MeetingStatus }) {
  const variant =
    status === "READY" ? "success" : status === "FAILED" ? "destructive" : "warning";
  return <Badge variant={variant}>{statusLabel(status)}</Badge>;
}

export function ActionStatusBadge({ status }: { status: string }) {
  const variant = status === "DONE" ? "success" : status === "IN_PROGRESS" ? "default" : "secondary";
  const label = status === "IN_PROGRESS" ? "In progress" : status === "DONE" ? "Done" : "Open";
  return <Badge variant={variant}>{label}</Badge>;
}
