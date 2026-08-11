"use client";

/**
 * The follow-up recap email for a meeting.
 *
 * The draft is editable before sending: the model is grounded in the brief, but
 * the user's name is on the email, so the final wording has to be theirs.
 */

import * as React from "react";
import { toast } from "sonner";
import { Mail, Loader2, Copy, Check, Send, RotateCcw } from "lucide-react";
import { useDraftFollowUpEmailMutation } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function FollowUpEmail({ meetingId }: { meetingId: string }) {
  const [draft, { isLoading }] = useDraftFollowUpEmailMutation();
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [ready, setReady] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  async function generate() {
    try {
      const result = await draft(meetingId).unwrap();
      setSubject(result.subject);
      setBody(result.body);
      setReady(true);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Couldn't copy to the clipboard.");
    }
  }

  // mailto keeps this useful without an email integration: it opens whatever
  // client the user already has, with the draft prefilled.
  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-4 w-4 text-primary" /> Follow-up email
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!ready ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              Draft a recap from this meeting&apos;s summary and action items —
              editable before you send it.
            </p>
            <Button onClick={generate} disabled={isLoading} className="gap-2">
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
              {isLoading ? "Drafting…" : "Draft follow-up"}
            </Button>
          </div>
        ) : (
          <>
            <div className="grid gap-2">
              <Label htmlFor="email-subject">Subject</Label>
              <Input
                id="email-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email-body">Body</Label>
              <Textarea
                id="email-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={12}
                className="font-sans"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild className="gap-2">
                <a href={mailto}>
                  <Send className="h-4 w-4" /> Open in email
                </a>
              </Button>
              <Button variant="outline" onClick={onCopy} className="gap-2">
                {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button variant="ghost" onClick={generate} disabled={isLoading} className="gap-2">
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                Redraft
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function errorMessage(err: unknown): string {
  if (typeof err === "object" && err && "data" in err) {
    const data = (err as { data?: { message?: string } }).data;
    if (data?.message) return data.message;
  }
  return "Couldn't draft the email.";
}
