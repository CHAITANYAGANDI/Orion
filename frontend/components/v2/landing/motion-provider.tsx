"use client";

/**
 * The landing page's motion runtime, loaded once and deliberately narrow.
 *
 * <h2>Why this exists</h2>
 *
 * <p>Framer Motion's `motion.div` is a convenience that costs a bundle: it
 * statically pulls in every feature the library has, including drag gestures
 * and the layout-projection engine, because it cannot know which ones a given
 * component will use. On an authenticated screen that is a fair trade — the
 * bundle is already loaded and the user is already signed in. On the public
 * page it is not. This is the one route where a first-time reader pays for
 * every kilobyte before they have decided whether they want the product, and it
 * was costing 44.3 kB to animate a page that does not drag anything.
 *
 * <p>So the page renders `m` components instead, which ship only the renderer,
 * and this provider declares the features they may use.
 *
 * <h2>Why `domAnimation` and not `domMax`</h2>
 *
 * <p>`domAnimation` is renderer + animation + exit + inView + tap + focus +
 * hover. `domMax` adds drag and layout projection, and projection is the
 * expensive half of the library. Checked against what the page actually does:
 *
 * <ul>
 *   <li>`initial` / `animate` / `transition` / `variants` — animation</li>
 *   <li>`AnimatePresence` with `exit`, in the stage window and the language
 *       line — exit</li>
 *   <li>`whileInView` with `viewport`, in every reveal — inView</li>
 * </ul>
 *
 * <p>Nothing on this page drags, pans, or animates layout: there is no `drag`,
 * no `layout` and no `layoutId` anywhere in it. So `domMax` would be paying for
 * two features to go unused, which is the thing this file exists to stop.
 *
 * <h2>Why the features are loaded synchronously</h2>
 *
 * <p>`LazyMotion` also accepts `() => import(...)`, which defers the feature
 * chunk past first paint. That is a further saving and it is deliberately not
 * taken. Until the chunk lands, `m` components render inert — so a reveal whose
 * viewport crossing happened during the gap would simply not fire, and the Ask
 * sequence's first beat would start against a component that cannot yet
 * animate. The behaviour on this page is approved; trading a few kilobytes for
 * a timing race in it is not a trade worth making. Synchronous loading keeps
 * every duration, delay and trigger point exactly where it was.
 *
 * <h2>`strict`</h2>
 *
 * <p>Throws, in development only, if a full `motion` component is ever rendered
 * inside this tree. Without it the saving rots silently: one `motion.div` added
 * later pulls the whole library back onto the public page and nothing fails,
 * nothing warns, and the bundle quietly returns to where it started.
 */

import * as React from "react";
import { LazyMotion, domAnimation } from "framer-motion";

export function LandingMotion({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      {children}
    </LazyMotion>
  );
}
