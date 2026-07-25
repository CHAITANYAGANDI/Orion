import Link from "next/link";
import {
  Mic,
  FileText,
  ListChecks,
  ShieldCheck,
  Zap,
  Bot,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const FEATURES = [
  { icon: FileText, title: "Accurate transcripts", body: "Upload audio or video and get a clean, timestamped transcript in seconds." },
  { icon: ListChecks, title: "Action items & owners", body: "Every task, owner, due date and priority extracted with the source sentence." },
  { icon: Zap, title: "Decisions & risks", body: "See what was decided, by whom, and the blockers that need attention." },
  { icon: Bot, title: "Agent follow-ups", body: "With approval, draft emails, create tasks, schedule meetings and Notion notes." },
  { icon: ShieldCheck, title: "Private by design", body: "Scoped access per user, presigned uploads, audit logs and data deletion." },
  { icon: Mic, title: "Live progress", body: "Watch transcription → summary → extraction stream in real time over WebSockets." },
];

const STEPS = [
  { n: "1", title: "Upload audio", body: "Drag in a recording. It goes straight to private storage via a presigned URL." },
  { n: "2", title: "AI processes it", body: "Transcribe, summarize, and extract decisions, action items and risks — asynchronously." },
  { n: "3", title: "Track & export", body: "Turn items into tasks, search past meetings, and export a clean brief." },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      {/* Nav */}
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Mic className="h-4 w-4" />
            </div>
            <span className="font-semibold">Recallix AI</span>
          </div>
          <nav className="flex items-center gap-2">
            <Button variant="ghost" asChild>
              <Link href="/dashboard">Sign in</Link>
            </Button>
            <Button asChild>
              <Link href="/dashboard">
                Open app <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden border-b">
        <div className="absolute inset-0 hero-grid" aria-hidden />
        <div className="relative mx-auto max-w-6xl px-4 py-24 text-center">
          <Badge className="mb-4">AI meeting notes & action items in seconds</Badge>
          <h1 className="mx-auto max-w-3xl text-balance text-4xl font-bold tracking-tight sm:text-6xl">
            Turn meeting audio into decisions, tasks, and clean summaries
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-balance text-lg text-muted-foreground">
            Recallix AI transcribes your meetings, summarizes the discussion, and extracts every
            decision, action item and risk — so nothing gets missed.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Button size="lg" asChild>
              <Link href="/upload">
                Upload a meeting <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/dashboard">View dashboard</Link>
            </Button>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Runs end-to-end with dev auth and mock AI — no account or API key required.
          </p>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <h2 className="text-center text-3xl font-bold tracking-tight">How it works</h2>
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {STEPS.map((s) => (
            <Card key={s.n}>
              <CardContent className="pt-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground">
                  {s.n}
                </div>
                <h3 className="mt-4 text-lg font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="border-y bg-muted/30">
        <div className="mx-auto max-w-6xl px-4 py-20">
          <h2 className="text-center text-3xl font-bold tracking-tight">Everything from one recording</h2>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <Card key={f.title}>
                  <CardContent className="pt-6">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="h-5 w-5" />
                    </div>
                    <h3 className="mt-4 font-semibold">{f.title}</h3>
                    <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <h2 className="text-center text-3xl font-bold tracking-tight">Simple pricing</h2>
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {[
            { name: "Free", price: "$0", features: ["5 meetings / month", "60 AI minutes", "Transcripts & summaries"] },
            { name: "Pro", price: "$19", features: ["50 meetings / month", "600 AI minutes", "Exports & search", "Agent follow-ups"], highlight: true },
            { name: "Premium", price: "$49", features: ["Unlimited meetings", "Unlimited AI minutes", "Priority processing", "All integrations"] },
          ].map((p) => (
            <Card key={p.name} className={p.highlight ? "border-primary shadow-md" : ""}>
              <CardContent className="pt-6">
                {p.highlight && <Badge className="mb-3">Most popular</Badge>}
                <h3 className="text-lg font-semibold">{p.name}</h3>
                <p className="mt-2 text-3xl font-bold">
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
                <Button className="mt-6 w-full" variant={p.highlight ? "default" : "outline"} asChild>
                  <Link href="/billing">Get started</Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-8 text-sm text-muted-foreground sm:flex-row">
          <span>© {new Date().getFullYear()} Recallix AI</span>
          <span>Built with Next.js · Spring Boot · FastAPI · Kafka</span>
        </div>
      </footer>
    </div>
  );
}
