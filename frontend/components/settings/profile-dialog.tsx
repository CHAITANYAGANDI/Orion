"use client";

/**
 * "Your Profile" — the four things a person can say about themselves here.
 *
 * <p>A dialog rather than inline fields, and that is the point of it: the
 * settings page is read far more often than it is edited, and a page whose
 * every field is an input invites somebody to change one by accident while
 * scanning it. Editing is a thing you decide to start.
 *
 * <p>The password is not typed into this form. It is not Reverie's to hold —
 * there is no password column and no login form; the identity provider owns
 * sign-in — so the row shows dots and opens a dialog that hands the change to
 * the provider. Putting an editable box here instead would mean either storing
 * a credential this product has deliberately never stored, or a control that
 * silently did nothing.
 */

import * as React from "react";
import { Camera, ImagePlus, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { CameraCapture } from "@/components/settings/camera-capture";
import { ChangePasswordDialog } from "@/components/settings/change-password-dialog";
import { AvatarError, avatarFromFile, initialsOf } from "@/lib/avatar";
import { AccountActionError, changePassword } from "@/lib/account-actions";
import type { IdentityPermissions } from "@/lib/identity-owner";
import { cn } from "@/lib/utils";

export interface ProfileForm {
  displayName: string;
  email: string;
  avatarUrl: string;
}

/**
 * What actually goes to Reverie's preferences endpoint — <b>only the fields this
 * account is allowed to change</b>.
 *
 * <h2>Why a field has to be absent rather than unchanged</h2>
 *
 * <p>Sending the current value back looks harmless and is not. `users.email` is
 * <em>null</em> for a Google account — Clerk's default session token carries no
 * email claim, so `provision` never had one to store — while the dialog shows
 * the address it read from Clerk. So "unchanged" on screen is a change to the
 * server, and `UserService.cleanAccountEmail` refuses it.
 *
 * <p>Which is how changing a photo produced "Your email address is managed by
 * your sign-in provider". The address rode along in a request that had nothing
 * to do with it, and took the whole save down with it.
 *
 * <p>The endpoint treats a missing field as "leave it alone", so the fix is to
 * send nothing rather than something. The address is now never sent by anybody
 * — it is a display on every screen that shows it — but the rule stands for the
 * name, which a Google account does not own either.
 */
export interface ProfilePatch {
  /** Reverie's own column, and the only one every account owns. */
  avatarUrl: string;
  /** Present only where the name is this account's to set. */
  displayName?: string;
}

export function ProfileDialog({
  open,
  initial,
  /**
   * Which of the name and the password this account may change. See
   * lib/identity-owner: an account made with Google owns neither here, and one
   * made with an email owns both. The address is nobody's to change.
   */
  permissions,
  saving,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: ProfileForm;
  permissions: IdentityPermissions;
  saving?: boolean;
  onClose: () => void;
  onSave: (patch: ProfilePatch) => void;
}) {
  const [form, setForm] = React.useState<ProfileForm>(initial);
  const [camera, setCamera] = React.useState(false);
  const [password, setPassword] = React.useState(false);
  const [changing, setChanging] = React.useState(false);
  const [passwordError, setPasswordError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  // Reset from props each time it opens, so cancelling really discards. Keyed
  // on `open` rather than on `initial`, which is a fresh object every render
  // and would reset the form under the user's fingers as they typed.
  React.useEffect(() => {
    if (open) setForm(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function set<K extends keyof ProfileForm>(key: K, value: ProfileForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    try {
      set("avatarUrl", await avatarFromFile(file));
    } catch (err) {
      toast.error(err instanceof AvatarError ? err.message : "That image could not be used.");
    } finally {
      // Cleared so choosing the same file twice fires change again — otherwise
      // a failed pick cannot be retried without picking something else first.
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function submitPassword(current: string, next: string) {
    setChanging(true);
    setPasswordError(null);
    try {
      await changePassword(current, next);
      setPassword(false);
      toast.success("Password changed. Other sessions have been signed out.");
    } catch (err) {
      setPasswordError(
        err instanceof AccountActionError
          ? err.message
          : "That password could not be changed.",
      );
    } finally {
      setChanging(false);
    }
  }

  /** See {@link ProfilePatch}: what may be sent, rather than what is on screen. */
  function submitted(): ProfilePatch {
    // The photo is Reverie's own column and is nobody else's business, so it is
    // always sent. The name goes only where this account owns it, and the
    // address goes nowhere at all -- it is not editable on any screen.
    const patch: ProfilePatch = { avatarUrl: form.avatarUrl };
    if (permissions.name) patch.displayName = form.displayName;
    return patch;
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Your Profile</DialogTitle>
            <DialogDescription className="sr-only">
              Your name, photo and how you sign in.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* ---- photo ---- */}
            <div className="space-y-2">
              <Label>Your Photo</Label>
              <div className="flex items-center gap-3">
                <Avatar url={form.avatarUrl} name={form.displayName} />
                <div className="flex gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    data-testid="avatar-file"
                    onChange={(e) => void pickFile(e.target.files?.[0])}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Upload a photo"
                    onClick={() => fileRef.current?.click()}
                  >
                    <ImagePlus className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Take a photo"
                    onClick={() => setCamera(true)}
                  >
                    <Camera className="h-4 w-4" />
                  </Button>
                  {form.avatarUrl && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove photo"
                      onClick={() => set("avatarUrl", "")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {/* Said out loud because all three fields below it say the
                opposite: whatever Google supplies, the picture Reverie shows is
                one this account uploaded, in a column Reverie owns. */}
            {permissions.owner === "external" && (
              <p className="text-xs text-muted-foreground">
                Your photo is yours to set here, whatever {permissions.ownerLabel} uses.
              </p>
            )}

            {/* ---- name ---- */}
            <div className="space-y-1.5">
              <Label htmlFor="profile-name">Full Name</Label>
              <Input
                id="profile-name"
                value={form.displayName}
                disabled={!permissions.name}
                placeholder="Priya Raman"
                onChange={(e) => set("displayName", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {permissions.name ? (
                  <>
                    Spell it the way your transcripts do — that is what action items are matched
                    against.
                  </>
                ) : (
                  <>Your name comes from {permissions.ownerLabel}. Change it there.</>
                )}
              </p>
            </div>

            {/* ---- email ---- */}
            <div className="space-y-1.5">
              <Label htmlFor="profile-email">Email</Label>
              <Input
                id="profile-email"
                type="email"
                value={form.email}
                // A display on every account, and never an edit. The address is
                // the credential, so every route to changing it is a route to
                // losing an account -- see lib/account-actions.
                disabled
                readOnly
                placeholder="you@example.com"
              />
              <p className="text-xs text-muted-foreground">
                {permissions.ownerLabel ? (
                  <>Your email comes from {permissions.ownerLabel}. Change it there and it changes here.</>
                ) : (
                  <>The address on your account. It is fixed once the account is made.</>
                )}
              </p>
            </div>

            {/* ---- password ---- */}
            <div className="space-y-1.5">
              <Label htmlFor="profile-password">Password</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="profile-password"
                  type="password"
                  value="••••••••••"
                  readOnly
                  disabled
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Change password"
                  disabled={!permissions.password}
                  onClick={() => {
                    setPasswordError(null);
                    setPassword(true);
                  }}
                >
                  Change
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {permissions.password ? (
                  "Changing it signs out your other sessions."
                ) : permissions.owner === "external" ? (
                  // The important half of this: an account that signs in with
                  // Google has no password anywhere. Offering the dialog would
                  // be offering a form that can only fail, because there is no
                  // current password to give it.
                  <>You sign in with {permissions.ownerLabel}, so there is no password here.</>
                ) : (
                  "Development session — there is no password to change."
                )}
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => onSave(submitted())} disabled={saving} className="gap-1.5">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Finish
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <CameraCapture
        open={camera}
        onClose={() => setCamera(false)}
        onCapture={(dataUrl) => {
          set("avatarUrl", dataUrl);
          setCamera(false);
        }}
      />

      <ChangePasswordDialog
        open={password}
        busy={changing}
        error={passwordError}
        onClose={() => setPassword(false)}
        onSubmit={(current, next) => void submitPassword(current, next)}
      />
    </>
  );
}

/** The circle, showing the picture if there is one and initials if there is not. */
export function Avatar({
  url,
  name,
  className,
}: {
  url?: string | null;
  name?: string | null;
  className?: string;
}) {
  const base =
    "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary font-bold text-primary-foreground";
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt="" className={cn(base, "h-14 w-14 object-cover", className)} />
    );
  }
  return (
    <span className={cn(base, "h-14 w-14 text-lg", className)} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
