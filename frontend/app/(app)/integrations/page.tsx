"use client";

import { toast } from "sonner";
import { Loader2, Plug, Check } from "lucide-react";
import {
  useGetIntegrationsQuery,
  useConnectIntegrationMutation,
  useDisconnectIntegrationMutation,
} from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import type { IntegrationProvider } from "@/lib/types";

const META: Record<IntegrationProvider, { name: string; desc: string }> = {
  notion: { name: "Notion", desc: "Create meeting notes, to-do lists and decision logs." },
  gmail: { name: "Gmail", desc: "Draft and send follow-up emails after approval." },
  google_calendar: { name: "Google Calendar", desc: "Schedule follow-up meetings from outcomes." },
  outlook_mail: { name: "Outlook Mail", desc: "Draft and send Microsoft work emails." },
  outlook_calendar: { name: "Outlook Calendar", desc: "Create Microsoft calendar meetings." },
  microsoft_tasks: { name: "Microsoft Tasks", desc: "Create tasks from action items." },
};

export default function IntegrationsPage() {
  const { data, isLoading } = useGetIntegrationsQuery();
  const [connect, connectState] = useConnectIntegrationMutation();
  const [disconnect, disconnectState] = useDisconnectIntegrationMutation();
  const busy = connectState.isLoading || disconnectState.isLoading;

  async function onConnect(p: IntegrationProvider) {
    try {
      await connect(p).unwrap();
      toast.success(`Connected ${META[p].name}.`);
    } catch {
      toast.error("Could not connect.");
    }
  }
  async function onDisconnect(p: IntegrationProvider) {
    try {
      await disconnect(p).unwrap();
      toast.success(`Disconnected ${META[p].name}.`);
    } catch {
      toast.error("Could not disconnect.");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Connect the apps you work in. Nothing is written to them yet — connecting only stores the link.
        </p>
      </div>

      <Badge variant="secondary">Phase 2 · scaffolded (OAuth flows stubbed in this build)</Badge>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {data?.map((it) => {
            const meta = META[it.provider];
            const connected = it.status === "CONNECTED";
            return (
              <Card key={it.provider}>
                <CardContent className="flex items-start justify-between gap-3 pt-6">
                  <div className="flex gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Plug className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="font-medium">{meta.name}</p>
                      <p className="text-sm text-muted-foreground">{meta.desc}</p>
                      {connected && it.connectedAt && (
                        <p className="mt-1 text-xs text-muted-foreground">Connected {formatDateTime(it.connectedAt)}</p>
                      )}
                    </div>
                  </div>
                  {connected ? (
                    <div className="flex flex-col items-end gap-2">
                      <Badge variant="success" className="gap-1">
                        <Check className="h-3 w-3" /> Connected
                      </Badge>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDisconnect(it.provider)}>
                        Disconnect
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" disabled={busy} onClick={() => onConnect(it.provider)}>
                      {connectState.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Connect
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
