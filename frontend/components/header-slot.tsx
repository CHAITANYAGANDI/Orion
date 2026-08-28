"use client";

/**
 * A place in the top bar that a page can put its own controls in.
 *
 * Share, Export and the overflow menu belong to one meeting, and they used to
 * be drawn in the page body beside the title. That put two rows of controls
 * within an inch of each other — the shell's Import and Record above, the
 * document's own actions below — and neither row explained why it was not the
 * other one. They are all "things you do to what is on screen"; they belong on
 * one line.
 *
 * ## Why a portal rather than moving the buttons into the shell
 *
 * The shell renders the header and knows nothing about meetings. Export alone
 * needs the summary, the action items, the transcript, the audio content type
 * and *which language the page is currently being read in* — the last of which
 * is page state, not a query, so a copy of these controls living in the shell
 * would either duplicate five hooks or quietly export the English while you
 * read the Spanish.
 *
 * A portal moves the rendered output and leaves every handler, dialog and piece
 * of state exactly where it already is. `FolderHeaderActions` takes the other
 * approach — the shell renders it from the path — and that works there because
 * a folder's actions need a folder id and nothing else.
 *
 * ## Mounting
 *
 * The target does not exist during the first render or on the server, so this
 * renders nothing until it has found one. Anything inside is therefore
 * client-only and one frame late, which is invisible for a row of buttons and
 * is the price of not making the shell import the meeting page's world.
 */

import * as React from "react";
import { createPortal } from "react-dom";

/** The id of the element in the shell header that receives page actions. */
export const HEADER_SLOT_ID = "orion-header-actions";

export function HeaderSlot({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    setTarget(document.getElementById(HEADER_SLOT_ID));
  }, []);

  if (!target) return null;
  return createPortal(children, target);
}
