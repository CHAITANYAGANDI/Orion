"use client";

import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * The one place a toast is described.
 *
 * <p><b>Top centre, and small.</b> It used to sit top-right in the app's full
 * "rich colours" palette — a wide, saturated panel that landed on top of the
 * chat rail and the meeting menu, which are the two things most likely to be
 * open when one fires. Centred at the top it covers only the page's own
 * chrome, and narrowing it to what the sentence needs keeps it a remark rather
 * than a panel.
 *
 * <p><b>No buttons.</b> Sonner will happily render an action, and two toasts
 * used one — a "recording is ready" and a "your answer is ready", both offering
 * Open. A control that appears unannounced, over whatever is being read, and
 * disappears on a timer is a control you cannot rely on reaching; and both
 * destinations are one ordinary click away in the list or the rail. `action` is
 * therefore not passed anywhere, and the styling below leaves nothing for it.
 *
 * <p><b>What a toast is for here.</b> Confirming something the user just did,
 * or saying plainly that it did not work. Not for reporting what the server
 * called the failure: `err.message` on a rejected fetch is "Failed to fetch" or
 * a stack-shaped string, which tells somebody nothing they can act on. See
 * `uploadError` in lib/uploads.ts for how that is kept out.
 */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      // Fixed, because the app is. Sonner picks its own surface colours from
      // this rather than from the CSS variables below, so leaving it on
      // "system" would put a light toast over a dark page for anybody whose OS
      // is set to light.
      theme="dark"
      position="top-center"
      className="toaster group"
      // Narrower than sonner's 356px default, which is a width for a paragraph.
      // Overrides the variable sonner sets inline; the user `style` is spread
      // after its own in the Toaster.
      style={{ "--width": "20rem" } as React.CSSProperties}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground " +
            "group-[.toaster]:border-border group-[.toaster]:shadow-md " +
            "group-[.toaster]:rounded-lg group-[.toaster]:px-3.5 group-[.toaster]:py-2.5 " +
            "group-[.toaster]:gap-2.5",
          title: "group-[.toast]:text-[13px] group-[.toast]:font-medium group-[.toast]:leading-snug",
          description: "group-[.toast]:text-xs group-[.toast]:text-muted-foreground",
          icon: "group-[.toast]:m-0 group-[.toast]:shrink-0",
        },
      }}
      {...props}
    />
  );
}
