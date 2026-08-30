"use client";

/**
 * Change the address you sign in with.
 *
 * <h2>Two steps, because one would be a way to lose an account</h2>
 *
 * <p>The address is the credential — it is what sign-in matches on — so a
 * single field with a Save button would let a typo lock somebody out of their
 * own workspace permanently. Instead the new address is added to the account,
 * a code is sent to it, and nothing is promoted until that code comes back.
 * Until then the old address still signs in.
 *
 * <p>Which is also why Cancel is not merely a close: an unverified address left
 * on the account is a loose end, so backing out takes it off again.
 *
 * <p>Offered only for accounts Orion's own sign-up made. Under Google the
 * address belongs to Google — see lib/identity-owner.
 */

import * as React from "react";
import { Loader2, Mail } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ChangeEmailDialog({
  open,
  current,
  busy,
  error,
  /** Set once the code has been sent, so this component knows which step it is on. */
  sentTo,
  onClose,
  onSend,
  onConfirm,
}: {
  open: boolean;
  /** The address being replaced, shown so nobody changes the wrong account. */
  current: string;
  busy?: boolean;
  error?: string | null;
  sentTo: string | null;
  onClose: () => void;
  onSend: (address: string) => void;
  onConfirm: (code: string) => void;
}) {
  const [address, setAddress] = React.useState("");
  const [code, setCode] = React.useState("");

  // Cleared on the way out, so a half-finished change is not sitting in state
  // behind a closed dialog waiting to be reopened into.
  React.useEffect(() => {
    if (!open) {
      setAddress("");
      setCode("");
    }
  }, [open]);

  const step = sentTo ? "code" : "address";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change email</DialogTitle>
          <DialogDescription>
            {step === "address" ? (
              <>
                You sign in with <span className="text-foreground">{current}</span>. The new address
                has to be confirmed before it takes over.
              </>
            ) : (
              <>
                We sent a six-digit code to <span className="text-foreground">{sentTo}</span>. Until
                you enter it, {current} still signs you in.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (step === "address") onSend(address.trim());
            else onConfirm(code.trim());
          }}
        >
          {step === "address" ? (
            <div className="space-y-1.5">
              <Label htmlFor="new-email">New email</Label>
              <Input
                id="new-email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                required
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="email-code">Code</Label>
              <Input
                id="email-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
          )}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy} className="gap-1.5">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
              {step === "address" ? "Send code" : "Confirm address"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
