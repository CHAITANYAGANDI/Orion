"use client";

import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { useAppDispatch, useAppSelector } from "@/lib/hooks";
import { setNotifyEmail, setNotifyProcessingDone } from "@/lib/uiSlice";
import { useGetUsageQuery } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

export default function SettingsPage() {
  const { userId, mode } = useAuth();
  const usage = useGetUsageQuery();
  const dispatch = useAppDispatch();
  const ui = useAppSelector((s) => s.ui);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Profile, notifications and data.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label>User ID</Label>
            <Input value={userId} readOnly />
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Auth mode:</span>
            <Badge variant="secondary">{mode}</Badge>
            {usage.data && <Badge>{usage.data.plan}</Badge>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notifications</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ToggleRow
            label="Email me a summary when processing finishes"
            checked={ui.notifyEmail}
            onChange={(v) => dispatch(setNotifyEmail(v))}
          />
          <ToggleRow
            label="Show a browser notification when a brief is ready"
            checked={ui.notifyProcessingDone}
            onChange={(v) => dispatch(setNotifyProcessingDone(v))}
          />
          <p className="text-xs text-muted-foreground">Preferences are stored locally in this demo.</p>
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          <div>
            <p className="font-medium">Delete account data</p>
            <p className="text-sm text-muted-foreground">Removes meetings, transcripts and action items.</p>
          </div>
          <Button
            variant="destructive"
            onClick={() =>
              toast.info("Per-meeting deletion is available from each meeting's page in this build.")
            }
          >
            Request deletion
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border p-3">
      <span className="text-sm">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[hsl(var(--primary))]"
      />
    </label>
  );
}
