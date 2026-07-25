"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useGetUsageQuery, useCheckoutMutation } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";

export const dynamic = "force-dynamic";

const PLANS = [
  { id: "FREE", name: "Free", price: "$0", features: ["5 meetings / month", "60 AI minutes", "Transcripts & summaries"] },
  { id: "PRO", name: "Pro", price: "$19", features: ["50 meetings / month", "600 AI minutes", "Exports & search", "Agent follow-ups"] },
  { id: "PREMIUM", name: "Premium", price: "$49", features: ["Unlimited meetings", "Unlimited AI minutes", "Priority processing", "All integrations"] },
];

/** Reads ?upgraded / ?status query params. Isolated so useSearchParams sits
 *  behind a Suspense boundary (Next.js CSR-bailout requirement). */
function BillingToasts() {
  const params = useSearchParams();
  React.useEffect(() => {
    const upgraded = params.get("upgraded");
    const status = params.get("status");
    if (upgraded) toast.success(`Upgraded to ${upgraded}.`);
    if (status === "success") toast.success("Payment successful.");
    if (status === "cancelled") toast.info("Checkout cancelled.");
  }, [params]);
  return null;
}

export default function BillingPage() {
  const usage = useGetUsageQuery();
  const [checkout, { isLoading }] = useCheckoutMutation();
  const [pending, setPending] = React.useState<string | null>(null);

  const currentPlan = usage.data?.plan ?? "FREE";

  async function upgrade(plan: "PRO" | "PREMIUM") {
    try {
      setPending(plan);
      const res = await checkout({ plan }).unwrap();
      // Dev mode returns a local URL; real Stripe returns a hosted checkout URL.
      window.location.href = res.checkoutUrl;
    } catch {
      toast.error("Could not start checkout.");
      setPending(null);
    }
  }

  return (
    <div className="space-y-8">
      <React.Suspense fallback={null}>
        <BillingToasts />
      </React.Suspense>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Billing & plan</h1>
        <p className="text-sm text-muted-foreground">Manage your subscription and usage.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            Current usage
            <Badge>{currentPlan}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {usage.data ? (
            <>
              <UsageBar label="Meetings" used={usage.data.meetingsUsed} limit={usage.data.meetingsLimit} />
              <UsageBar label="AI minutes" used={usage.data.aiMinutesUsed} limit={usage.data.aiMinutesLimit} />
            </>
          ) : (
            <Skeleton className="h-16 w-full" />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-3">
        {PLANS.map((p) => {
          const isCurrent = p.id === currentPlan;
          const canUpgrade = p.id !== "FREE" && p.id !== currentPlan;
          return (
            <Card key={p.id} className={p.id === "PRO" ? "border-primary" : ""}>
              <CardContent className="pt-6">
                {isCurrent && <Badge variant="success" className="mb-3">Current plan</Badge>}
                <h3 className="text-lg font-semibold">{p.name}</h3>
                <p className="mt-1 text-3xl font-bold">
                  {p.price}
                  <span className="text-sm font-normal text-muted-foreground">/mo</span>
                </p>
                <ul className="mt-4 space-y-2 text-sm">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-success" /> {f}
                    </li>
                  ))}
                </ul>
                <Button
                  className="mt-6 w-full"
                  variant={p.id === "PRO" ? "default" : "outline"}
                  disabled={!canUpgrade || isLoading}
                  onClick={() => canUpgrade && upgrade(p.id as "PRO" | "PREMIUM")}
                >
                  {pending === p.id && isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {isCurrent ? "Current plan" : canUpgrade ? `Upgrade to ${p.name}` : "Included"}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Without a Stripe key configured, upgrades apply immediately in dev mode so the flow is fully demoable.
      </p>
    </div>
  );
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const unlimited = limit < 0;
  const pct = unlimited ? 4 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground">{unlimited ? `${used} / ∞` : `${used} / ${limit}`}</span>
      </div>
      <Progress value={pct} />
    </div>
  );
}
