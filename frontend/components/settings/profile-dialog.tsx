"use client";

/**
 * "Your Profile" — everything a person says about themselves, in one place.
 *
 * A dialog rather than inline fields, and that is the point of it: the settings
 * page is read far more often than it is edited, and a page whose every field
 * is an input invites somebody to change one by accident while scanning it.
 * Editing is a thing you decide to start.
 *
 * The password is shown and cannot be typed into. Recallix never holds one —
 * Clerk does, and a development session is identified by a header and has none
 * at all — so an editable box here would be a control that silently does
 * nothing. Showing the dots with a sentence saying who does hold it is the
 * honest version of the same row.
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
import { AvatarError, avatarFromFile, initialsOf } from "@/lib/avatar";
import { DEPARTMENTS, ROLES, withCurrent } from "@/lib/profile-options";
import { cn } from "@/lib/utils";

export interface ProfileForm {
  displayName: string;
  pronouns: string;
  department: string;
  jobRole: string;
  avatarUrl: string;
}

export function ProfileDialog({
  open,
  initial,
  email,
  passwordNote,
  saving,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: ProfileForm;
  /** From the sign-in provider, so it is shown and not edited. */
  email: string | null;
  passwordNote: string;
  saving?: boolean;
  onClose: () => void;
  onSave: (form: ProfileForm) => void;
}) {
  const [form, setForm] = React.useState<ProfileForm>(initial);
  const [camera, setCamera] = React.useState(false);
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

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Your Profile</DialogTitle>
            <DialogDescription className="sr-only">
              Your name, photo and how you are described across Recallix.
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
            <Text
              id="profile-name"
              label="Full Name"
              value={form.displayName}
              onChange={(v) => set("displayName", v)}
              placeholder="Priya Raman"
              hint="Spell it the way your transcripts do — that is what action items are matched against."
            />

            {/* ---- pronouns ---- */}
            <Text
              id="profile-pronouns"
              label="Pronouns"
              value={form.pronouns}
              onChange={(v) => set("pronouns", v)}
              placeholder="e.g. she/her, he/him, they/them"
              hint="Shown beside your name. Recallix never guesses this from anything."
            />

            {/* ---- email: theirs, not ours ---- */}
            <div className="space-y-1.5">
              <Label htmlFor="profile-email">Email</Label>
              <Input id="profile-email" value={email ?? ""} readOnly disabled
                     placeholder="No address from your sign-in provider" />
              <p className="text-xs text-muted-foreground">
                From your sign-in provider. Change it there and it changes here.
              </p>
            </div>

            {/* ---- password: shown, never held ---- */}
            <div className="space-y-1.5">
              <Label htmlFor="profile-password">Password</Label>
              <Input id="profile-password" type="password" value="••••••••••" readOnly disabled />
              <p className="text-xs text-muted-foreground">{passwordNote}</p>
            </div>

            <Choice
              id="profile-department"
              label="Department"
              value={form.department}
              options={withCurrent(DEPARTMENTS, form.department)}
              onChange={(v) => set("department", v)}
            />
            <Choice
              id="profile-role"
              label="Role"
              value={form.jobRole}
              options={withCurrent(ROLES, form.jobRole)}
              onChange={(v) => set("jobRole", v)}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => onSave(form)} disabled={saving} className="gap-1.5">
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
  const base = "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary font-bold text-primary-foreground";
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        className={cn(base, "h-14 w-14 object-cover", className)}
      />
    );
  }
  return (
    <span className={cn(base, "h-14 w-14 text-lg", className)} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}

function Text({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} placeholder={placeholder}
             onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * A list, plus whatever was already stored.
 *
 * These were free text before, so a real account may hold "Platform
 * Engineering" — a list that quietly dropped it would rewrite somebody's
 * profile the first time they opened this dialog to change something else.
 */
function Choice({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
          "ring-offset-background focus-visible:outline-none focus-visible:ring-2",
          "focus-visible:ring-ring focus-visible:ring-offset-2",
        )}
      >
        <option value="">Not set</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}
