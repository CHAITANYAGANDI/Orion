"use client";

/**
 * Change Password.
 *
 * <p>Orion has never held a password — there is no password column and no
 * login form; the identity provider owns sign-in. So this dialog collects and
 * checks, and the provider decides. That division is why the current password
 * is asked for: it is not verified here, it is passed through so the provider
 * can verify it, which is what stops somebody changing the password on a
 * borrowed, still-signed-in laptop.
 *
 * <p>Nothing typed here is logged, stored, or sent anywhere except to the
 * provider on submit, and the fields are cleared on every exit.
 */

import * as React from "react";
import { Check, Eye, EyeOff, Loader2, X } from "lucide-react";
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
import { PASSWORD_RULES, checkPassword } from "@/lib/password-rules";
import { cn } from "@/lib/utils";

export function ChangePasswordDialog({
  open,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy?: boolean;
  /** What the provider said, when it refused. */
  error?: string | null;
  onClose: () => void;
  onSubmit: (current: string, next: string) => void;
}) {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");

  // Emptied whenever the dialog goes away, so a password is never left sitting
  // in component state behind a closed dialog for the rest of the session.
  React.useEffect(() => {
    if (!open) {
      setCurrent("");
      setNext("");
      setConfirm("");
    }
  }, [open]);

  const check = checkPassword(current, next, confirm);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change Password</DialogTitle>
          <DialogDescription className="sr-only">
            Your current password, and the new one you want instead.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Secret
            id="current-password"
            label="Current password"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
          />

          <div className="space-y-2">
            <Secret
              id="new-password"
              label="New password"
              value={next}
              onChange={setNext}
              placeholder="New password"
              autoComplete="new-password"
            />
            <ul className="space-y-1">
              {PASSWORD_RULES.map((rule) => {
                const met = check.rules[rule.id];
                return (
                  <li
                    key={rule.id}
                    className={cn(
                      "flex items-center gap-2 text-sm",
                      met ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
                    )}
                  >
                    {met ? (
                      <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                    ) : (
                      <X className="h-4 w-4 shrink-0" aria-hidden="true" />
                    )}
                    {/* The state is in the text as well as the icon: a tick and
                        a cross differ only by shape, and roughly one man in
                        twelve cannot rely on the colour that reinforces it. */}
                    <span className="sr-only">{met ? "Met:" : "Not met:"}</span>
                    {rule.label}
                  </li>
                );
              })}
            </ul>
          </div>

          <Secret
            id="confirm-password"
            label="Confirm new password"
            value={confirm}
            onChange={setConfirm}
            placeholder="Confirm new password"
            autoComplete="new-password"
          />

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => onSubmit(current, next)}
            disabled={busy || check.blocker !== null}
            // The reason lives on the disabled button rather than as a line of
            // red text under the form: it is the control somebody is reaching
            // for, and it is where they look when it does not respond.
            title={check.blocker ?? undefined}
            className="gap-1.5"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Update
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A password box with the show/hide eye from the mock. */
function Secret({
  id,
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
}) {
  const [shown, setShown] = React.useState(false);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
          className="pr-10"
        />
        <button
          type="button"
          // Reveal exists because the alternative is people choosing a password
          // they can type blind, which is a shorter one.
          aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
