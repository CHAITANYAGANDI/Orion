"use client";

/**
 * LANGUAGES — one sentence, cycling through the languages it can be read in.
 *
 * <h2>Why a demonstration and not a count</h2>
 *
 * <p>"18 languages" is a number in a strip, which is the statistics block this
 * page deliberately does not have. What the product actually does is more
 * specific and more useful: it detects the language from the audio, and it will
 * render the brief, the action items and the transcript in another one — kept
 * once translated, so reading it again costs nothing.
 *
 * <p>So the moment is the same line of a brief, arriving in one language after
 * another. The right-to-left ones are laid out right-to-left, because that is
 * what the product does (`dir` is set from the language rather than sniffed
 * from the characters) and because a page that shows Arabic left-to-right has
 * demonstrated that it does not really support Arabic.
 *
 * <p>The eighteen are `getLanguages`; six are shown, which is enough to make
 * the point without turning the moment into a list.
 */

import * as React from "react";
import { AnimatePresence, m } from "framer-motion";
import { LANDING_EASE, useMotionAllowed } from "@/components/v2/landing/reveal";

/**
 * The same brief line, translated.
 *
 * <p>Six of the eighteen. `rtl` is a property of the language, not of the
 * string — see the note above.
 */
const LINES = [
  { code: "en", name: "English", text: "The team held list pricing and moved the annual discount to 15%." },
  { code: "es", name: "Español", text: "El equipo mantuvo el precio de lista y subió el descuento anual al 15 %." },
  { code: "de", name: "Deutsch", text: "Das Team behielt den Listenpreis und erhöhte den Jahresrabatt auf 15 %." },
  { code: "ja", name: "日本語", text: "チームは表示価格を維持し、年間割引を 15% に引き上げました。" },
  { code: "ar", name: "العربية", text: "أبقى الفريق على السعر المُعلن ورفع الخصم السنوي إلى ١٥٪.", rtl: true },
  { code: "hi", name: "हिन्दी", text: "टीम ने सूची मूल्य बनाए रखा और वार्षिक छूट 15% कर दी।" },
];

const EVERY_MS = 2600;

export function LanguageMoment() {
  const moving = useMotionAllowed();
  const [i, setI] = React.useState(0);

  React.useEffect(() => {
    if (!moving) return;
    const id = setInterval(() => setI((v) => (v + 1) % LINES.length), EVERY_MS);
    return () => clearInterval(id);
  }, [moving]);

  const line = LINES[i];

  return (
    <section aria-labelledby="languages" className="mx-auto max-w-doc px-6 lg:px-8">
      <div className="max-w-[46ch]">
        <p className="v2-label" id="languages">
          Languages
        </p>
        <h2 className="mt-3 text-title-l font-headline leading-[1.14] tracking-[-0.018em] text-ink">
          Read it in the language you think in.
        </h2>
        <p className="mt-4 text-[1.0625rem] leading-[1.6] text-ink-2">
          The language is detected from the audio, across eighteen of them. The
          brief, the action items and the transcript can each be read in another
          — and once translated it is kept, so opening it again costs nothing.
        </p>
      </div>

      {/*
       * The demonstration. A fixed height, because a line that is three words
       * shorter in German must not move the rest of the page.
       *
       * When motion is off this renders the English line and the six names,
       * which says the same thing without anything moving.
       */}
      <div aria-hidden className="mt-12">
        <div className="flex min-h-[6.5rem] items-start border-l border-brand-text/34 pl-5 sm:min-h-[5.5rem]">
          <AnimatePresence mode="wait" initial={false}>
            <m.p
              key={moving ? line.code : "static"}
              dir={moving && line.rtl ? "rtl" : undefined}
              initial={moving ? { opacity: 0, y: 8 } : false}
              animate={{ opacity: 1, y: 0 }}
              exit={moving ? { opacity: 0, y: -8 } : undefined}
              transition={{ duration: 0.45, ease: LANDING_EASE }}
              className="v2-read text-[1.1875rem] leading-[1.55] text-ink"
            >
              {moving ? line.text : LINES[0].text}
            </m.p>
          </AnimatePresence>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2">
          {LINES.map((l, n) => (
            <span
              key={l.code}
              className={
                moving && n === i
                  ? "text-callout text-ink transition-colors duration-500"
                  : "text-callout text-ink-4 transition-colors duration-500"
              }
            >
              {l.name}
            </span>
          ))}
          <span className="text-callout text-ink-5">and twelve more</span>
        </div>
      </div>
    </section>
  );
}
