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
 * <h2>The code that never arrives</h2>
 *
 * <p>A code step with no way back is the same dead end as the sign-up screen
 * had, and it fails at the exact thing this dialog exists to protect against.
 * Mistype the domain and the send succeeds — `gmaill.com` is a real place as
 * far as the mail system is concerned — the screen says a code is on its way,
 * and nothing arrives. There is then nothing to do but Cancel and start over,
 * with no clue as to what went wrong, because the address that was typed is no
 * longer on screen to be read back.
 *
 * <p>So the second step keeps both exits: another code, for mail that is slow
 * or filed as spam, and a way back to the address with what was typed still in
 * it. And the first step says "did you mean gmail.com?" before any of that is
 * needed — a hint beside the field, never a refusal, because plenty of real
 * domains are one letter from a famous one.
 *
 * <h2>The password it asks for first</h2>
 *
 * <p>Clerk guards its sensitive user operations with reverification: a session
 * that has not proved a first factor in the last few minutes may read anything
 * but may not change the credential. Adding an address is one of the guarded
 * ones, and rightly - changing the address you sign in with is precisely what
 * somebody at a borrowed, still-signed-in laptop would do.
 *
 * <p>Clerk's own profile component answers that by opening a dialog of its own.
 * This one asks in Orion's words, and only when Clerk actually asks: the step
 * appears in response to the refusal rather than in front of everybody every
 * time, because most people are already inside the window and would be typing
 * their password for nothing.
 *
 * <p>Offered only for accounts Orion's own sign-up made. Under Google the
 * address belongs to Google — see lib/identity-owner.
 */

import * as React from "react";
import { Loader2, Lock, Mail } from "lucide-react";
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
import { suggestAddress } from "@/lib/email-domain";

export function ChangeEmailDialog({
  open,
  current,
  busy,
  error,
  /** Set once the code has been sent, so this component knows which step it is on. */
  sentTo,
  /** Set when a second code has just gone out, so the button is not silent. */
  resent,
  /** Set when Clerk wants the password again before it will allow the change. */
  needsPassword,
  onClose,
  onSend,
  onResend,
  onRetype,
  onConfirm,
  onConfirmIdentity,
}: {
  open: boolean;
  /** The address being replaced, shown so nobody changes the wrong account. */
  current: string;
  busy?: boolean;
  error?: string | null;
  sentTo: string | null;
  resent?: boolean;
  needsPassword?: boolean;
  onClose: () => void;
  onSend: (address: string) => void;
  onResend: () => void;
  /** Back to the first step, taking the unverified address off the account. */
  onRetype: () => void;
  onConfirm: (code: string) => void;
  onConfirmIdentity: (password: string) => void;
}) {
  const [address, setAddress] = React.useState("");
  const [code, setCode] = React.useState("");
  const [password, setPassword] = React.useState("");

  // Cleared on the way out, so a half-finished change is not sitting in state
  // behind a closed dialog waiting to be reopened into.
  React.useEffect(() => {
    if (!open) {
      setAddress("");
      setCode("");
      setPassword("");
    }
  }, [open]);

  const step = needsPassword ? "identity" : sentTo ? "code" : "address";
  /*
   * Deliberately not cleared when the code step opens. Coming back to fix one
   * character is the whole point of the way back, and an empty field would make
   * somebody retype an address they cannot see to compare.
   */
  const meant = step === "address" ? suggestAddress(address.trim()) : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change email</DialogTitle>
          <DialogDescription>
            {step === "identity" ? (
              <>
                Changing the address you sign in with is how an account is taken, so your password
                is asked for first. It is not asked again for a few minutes.
              </>
            ) : step === "address" ? (
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
            if (step === "identity") onConfirmIdentity(password);
            else if (step === "address") onSend(address.trim());
            else onConfirm(code.trim());
          }}
        >
          {step === "identity" ? (
            <div className="space-y-1.5">
              <Label htmlFor="reverify-password">Current password</Label>
              <Input
                id="reverify-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          ) : step === "address" ? (
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
              {meant ? (
                <p className="text-sm text-muted-foreground">
                  Did you mean{" "}
                  <button
                    type="button"
                    onClick={() => setAddress(meant)}
                    className="font-medium text-foreground underline underline-offset-4"
                  >
                    {meant}
                  </button>
                  ?
                </p>
              ) : null}
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
              <div className="flex items-center justify-between pt-1 text-sm text-muted-foreground">
                <button
                  type="button"
                  onClick={onResend}
                  disabled={busy}
                  className="underline-offset-4 hover:text-foreground hover:underline disabled:opacity-60"
                >
                  Send another code
                </button>
                <button
                  type="button"
                  onClick={onRetype}
                  disabled={busy}
                  className="underline-offset-4 hover:text-foreground hover:underline disabled:opacity-60"
                >
                  Use a different address
                </button>
              </div>
              {resent ? (
                <p role="status" className="text-sm text-muted-foreground">
                  A new code is on its way. Check your spam folder too.
                </p>
              ) : null}
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
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : step === "identity" ? (
                <Lock className="h-4 w-4" />
              ) : (
                <Mail className="h-4 w-4" />
              )}
              {step === "identity" ? "Confirm" : step === "address" ? "Send code" : "Confirm address"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
