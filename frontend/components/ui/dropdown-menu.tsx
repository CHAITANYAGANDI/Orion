"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * A menu closes when you dismiss it. Leaving the window is not dismissing it.
 *
 * Radix's menu root closes on window blur, unconditionally:
 *
 *     const handleBlur = () => handleOpenChange(false);
 *     window.addEventListener("blur", handleBlur);
 *
 * So switching browser tabs, alt-tabbing to another window, or opening dev
 * tools took any open menu with it, and coming back left a reader looking for
 * a menu they had not closed. There is no prop for it — the listener is inside
 * `Menu.Root` — so the only way past is to hold `open` out here and decline
 * that particular close.
 *
 * `document.hasFocus()` is what tells it apart from a real one. The blur
 * handler runs while the window is not focused; a click outside, Escape and
 * choosing an item all happen while it is. So a close asked for by an
 * unfocused window is the one to ignore, and every other dismissal is
 * untouched.
 *
 * Controlled callers are unaffected: `open` and `onOpenChange` pass through,
 * and they hear about the closes that survive the filter.
 */
function DropdownMenu({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Root>) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolled;

  return (
    <DropdownMenuPrimitive.Root
      open={isOpen}
      onOpenChange={(next) => {
        if (!next && !document.hasFocus()) return;
        if (open === undefined) setUncontrolled(next);
        onOpenChange?.(next);
      }}
      {...props}
    />
  );
}

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>svg]:size-4",
      className
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label ref={ref} className={cn("px-2 py-1.5 text-sm font-semibold", className)} {...props} />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-muted", className)} {...props} />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
};
