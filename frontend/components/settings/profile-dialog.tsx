"use client";

/**
 * "Your Profile" — the four things a person can say about themselves here.
 *
 * <p>A dialog rather than inline fields, and that is the point of it: the
 * settings page is read far more often than it is edited, and a page whose
 * every field is an input invites somebody to change one by accident while
 * scanning it. Editing is a thing you decide to start.
 *
 * <p>The password is not typed into this form. It is not Orion's to hold —
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
import { ChangeEmailDialog } from "@/components/settings/change-email-dialog";
import { AvatarError, avatarFromFile, initialsOf } from "@/lib/avatar";
import {
  AccountActionError,
  cancelEmailChange,
  changePassword,
  confirmEmailChange,
  startEmailChange,
  type PendingEmail,
} from "@/lib/account-actions";
import type { IdentityPermissions } from "@/lib/identity-owner";
import { cn } from "@/lib/utils";

export interface ProfileForm {
  displayName: string;
  email: string;
  avatarUrl: string;
}

export function ProfileDialog({
  open,
  initial,
  /**
   * Which of these three fields this account is allowed to change, and where a
   * changed address has to go. See lib/identity-owner: an account made with
   * Google owns none of them here, and one made with an email owns all three.
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
  onSave: (form: ProfileForm) => void;
}) {
  const [form, setForm] = React.useState<ProfileForm>(initial);
  const [camera, setCamera] = React.useState(false);
  const [password, setPassword] = React.useState(false);
  const [changing, setChanging] = React.useState(false);
  const [passwordError, setPasswordError] = React.useState<string | null>(null);
  const [emailOpen, setEmailOpen] = React.useState(false);
  const [emailBusy, setEmailBusy] = React.useState(false);
  const [emailError, setEmailError] = React.useState<string | null>(null);
  const [emailPending, setEmailPending] = React.useState<PendingEmail | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  // Reset from props each time it opens, so cancelling really discards. Keyed
  // on `open` rather than on `initial`, which is a fresh object every render
  // and would reset the form under the user's fingers as they typed.
  React.useEffect(() => {
    if (open) setForm(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * The address a signed-out edit would be aimed at.
   *
   * <p>Under Clerk this is not a form field at all: it changes at the provider,
   * with a code, in its own dialog. The input below is a display of it.
   */
  const emailAtProvider = permissions.emailVia === "provider";

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

  async function sendEmailCode(address: string) {
    setEmailBusy(true);
    setEmailError(null);
    try {
      setEmailPending(await startEmailChange(address));
    } catch (err) {
      setEmailError(err instanceof AccountActionError ? err.message : "That address could not be added.");
    } finally {
      setEmailBusy(false);
    }
  }

  async function confirmEmailCode(code: string) {
    if (!emailPending) return;
    setEmailBusy(true);
    setEmailError(null);
    try {
      await confirmEmailChange(emailPending, code);
      set("email", emailPending.address);
      setEmailPending(null);
      setEmailOpen(false);
      toast.success("Email changed. Sign in with it from now on.");
    } catch (err) {
      setEmailError(err instanceof AccountActionError ? err.message : "That code did not confirm the address.");
    } finally {
      setEmailBusy(false);
    }
  }

  /**
   * What actually goes to Orion's preferences endpoint.
   *
   * <p>The address is stripped unless this deployment is the one that owns it.
   * Under Clerk it has already been changed at the provider (or not at all),
   * and `UserService.cleanAccountEmail` refuses it — so sending it would turn a
   * successful save of the name into a rejected request.
   */
  function submitted(): ProfileForm {
    return permissions.emailVia === "preferences" ? form : { ...form, email: initial.email };
  }

  /** Backing out takes the unverified address off the account again. */
  function abandonEmailChange() {
    if (emailPending) void cancelEmailChange(emailPending);
    setEmailPending(null);
    setEmailError(null);
    setEmailOpen(false);
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
              <div className="flex items-center gap-2">
                <Input
                  id="profile-email"
                  type="email"
                  value={form.email}
                  // Under Clerk this input is a display, never an edit: the
                  // address is the credential, so it changes at the provider
                  // with a code to prove the new one. The button opens that.
                  disabled={!permissions.email || emailAtProvider}
                  placeholder="you@example.com"
                  className="flex-1"
                  onChange={(e) => set("email", e.target.value)}
                />
                {emailAtProvider && (
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="Change email"
                    onClick={() => {
                      setEmailError(null);
                      setEmailPending(null);
                      setEmailOpen(true);
                    }}
                  >
                    Change
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {!permissions.email ? (
                  // Not merely disabled: the server refuses it too, because the
                  // column is rewritten from the sign-in token on the next
                  // request and an accepted edit would silently revert.
                  <>Your email comes from {permissions.ownerLabel}. Change it there and it changes here.</>
                ) : emailAtProvider ? (
                  <>This is what you sign in with. The new address has to be confirmed first.</>
                ) : (
                  <>Where anything Orion sends you would go.</>
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

      <ChangeEmailDialog
        open={emailOpen}
        current={initial.email}
        busy={emailBusy}
        error={emailError}
        sentTo={emailPending?.address ?? null}
        onClose={abandonEmailChange}
        onSend={(address) => void sendEmailCode(address)}
        onConfirm={(code) => void confirmEmailCode(code)}
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
