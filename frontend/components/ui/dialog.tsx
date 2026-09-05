"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn("fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0", className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // `grid-cols-[minmax(0,1fr)]` is load-bearing, not decoration. A grid
        // item's default `min-width` is `auto`, which means it refuses to
        // shrink below its min-content width — so one long unbreakable string
        // (a dropped file called
        // "product-marketing-meeting-weekly-2021-06-28-320-kbps.mp3", say)
        // widens the column past `max-w-*`. The dialog's own border stops at
        // the max width while its children carry on past it, which reads as
        // the dialog having been drawn twice, slightly offset.
        //
        // Naming a column that may shrink to zero restores the floor, and every
        // `truncate` and `min-w-0` inside a dialog starts working again. Here
        // rather than in each dialog, because every one of them is one long
        // filename, URL or meeting title away from the same bug.
        //
        // `max-h` and `overflow-y-auto` are the phone half of the same problem.
        // A dialog centred on a 844px-tall viewport with more content than fits
        // has its top and bottom outside the window, and the close button goes
        // with them -- so the way out of a dialog is off screen. Capping it at
        // the viewport minus a margin and scrolling the inside keeps every
        // dialog dismissible at every height, without any of them having to
        // know how tall they are.
        "fixed left-[50%] top-[50%] z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100vw-1.5rem)] max-w-lg grid-cols-[minmax(0,1fr)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-lg border bg-background p-5 shadow-lg duration-200 sm:w-full sm:p-6",
        className
      )}
      {...props}
    >
      {children}
      {/* 44px of tap target around a 16px glyph. The close button is the
          one control in a dialog somebody reaches for in a hurry, and on a
          phone it was a 16px square in the corner. */}
      <DialogPrimitive.Close className="absolute right-2 top-2 flex h-10 w-10 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100 focus:outline-none">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />;
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export { Dialog, DialogPortal, DialogOverlay, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogDescription };
