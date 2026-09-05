"use client";

/**
 * Scroll choreography for the public page, and nowhere else.
 *
 * <h2>What motion is for here</h2>
 *
 * <p>Not decoration. A landing page is read in one pass, top to bottom, and the
 * only thing motion can honestly do is <em>pace</em> that pass — hold a moment
 * until the reader arrives at it, then let it settle. Large moments, one at a
 * time. That is the whole brief: functional motion, deliberate whitespace, and
 * demonstrations rather than assertions.
 *
 * <p>So there are two primitives and no more. Something arrives, or a group of
 * things arrive in sequence. Anything beyond that — parallax, looping
 * backgrounds, carousels — is the page performing for itself.
 *
 * <h2>Three rules every animation on this page obeys</h2>
 *
 * <ol>
 *   <li><b>Reduced motion is absence, not slowness.</b> `useReducedMotion`
 *       returns true and the content is simply there. Not a faster fade — no
 *       fade. The product's own stylesheet already zeroes every duration under
 *       that query; this is the JavaScript half of the same policy.</li>
 *   <li><b>Once.</b> `viewport={{ once: true }}` everywhere. A section that
 *       re-animates every time it scrolls back into view turns a page into a
 *       slideshow and makes finding a sentence again a chore.</li>
 *   <li><b>Never a reason the text is missing.</b> The initial state is
 *       `opacity: 0`, which is rendered into the server HTML — so the page
 *       carries a `<noscript>` override that forces everything visible. A
 *       marketing page whose copy depends on JavaScript is a marketing page
 *       with no copy for anybody whose JavaScript failed.</li>
 * </ol>
 */

import * as React from "react";
import { motion, useReducedMotion, type Variants } from "framer-motion";

/** The one curve. Decelerate: fast away, settling rather than stopping. */
const EASE = [0.32, 0.72, 0, 1] as const;

/**
 * One thing arriving.
 *
 * @param delay seconds. Use sparingly — a delay is a promise that what is
 *   underneath is worth waiting for, and on a page somebody is scrolling it is
 *   usually a promise you cannot keep.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 14,
  as = "div",
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  /** How far it rises. 14px reads as arriving; 40px reads as flying in. */
  y?: number;
  as?: "div" | "section" | "li" | "p";
}) {
  const still = useReducedMotion();
  const Tag = motion[as];

  if (still) {
    const Plain = as;
    return <Plain className={className}>{children}</Plain>;
  }

  return (
    <Tag
      data-reveal
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -12% 0px" }}
      transition={{ duration: 0.62, ease: EASE, delay }}
    >
      {children}
    </Tag>
  );
}

const GROUP: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
};

const ITEM: Variants = {
  hidden: { opacity: 0, y: 10 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
};

/**
 * Several things arriving in sequence.
 *
 * <p>70ms apart. Below about 50 the stagger is not perceptible and the group
 * may as well arrive together; above about 120 the last item is late enough
 * that the eye has already moved on and the movement is a distraction behind
 * whatever is being read next.
 *
 * <p>Children are wrapped rather than asked to opt in, so a list does not have
 * to know it is being staggered — which keeps the markup readable and means
 * adding a row cannot forget the animation.
 */
export function Stagger({
  children,
  className,
  as = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "ul";
}) {
  const still = useReducedMotion();

  if (still) {
    const Plain = as;
    return <Plain className={className}>{children}</Plain>;
  }

  const Tag = motion[as];
  return (
    <Tag
      className={className}
      variants={GROUP}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, margin: "0px 0px -10% 0px" }}
    >
      {React.Children.map(children, (child, i) => (
        <motion.div key={i} data-reveal variants={ITEM}>
          {child}
        </motion.div>
      ))}
    </Tag>
  );
}

/**
 * Whether motion may run at all.
 *
 * <p>Exported so the two showcases can make the same decision this file makes,
 * rather than each reaching for `useReducedMotion` and reaching a different
 * conclusion about what "still" means.
 */
export function useMotionAllowed(): boolean {
  return !useReducedMotion();
}

/** The one curve, for components that animate something other than arrival. */
export const LANDING_EASE = EASE;
