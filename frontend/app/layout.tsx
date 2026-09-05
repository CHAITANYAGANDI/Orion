import type { Metadata } from "next";
import { Schibsted_Grotesk, Literata, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

/*
 * THREE FACES, THREE JOBS, AND THE BORDER BETWEEN THEM IS ABSOLUTE.
 *
 *   SANS   every word that is part of the interface
 *   SERIF  only inside a reading column — a transcript, a summary, an answer
 *   MONO   only quantities: timecodes, durations, counts, keycaps
 *
 * A serif outside a reading column is a bug. The one sanctioned exception is
 * the summary fragment in a list row, and it is sanctioned because that
 * fragment IS reading.
 *
 * All three are loaded as VARIABLE fonts — `weight` is deliberately omitted,
 * which is what makes next/font fetch the variable cut. The interface uses 420
 * for body and 560 for its emphasised weight, and neither exists as a static
 * instance: with a fixed weight list they would snap to 400 and 500 and the
 * one real hierarchy level between body and headline would disappear.
 */

// Schibsted Grotesk: a humanist grotesque with the neutrality of Helvetica and
// none of Inter's ubiquity. Chosen for its numerals and for how little it draws
// attention to itself at 13.5px, which is where nine tenths of this app's words
// live.
const sans = Schibsted_Grotesk({
  subsets: ["latin", "latin-ext"],
  variable: "--font-sans",
  display: "swap",
});

// Literata: low stroke contrast so it does not thin out on a dark ground, a
// tall x-height, and real optical sizes. It carries the transcript at
// 16.5/1.62 in a 680px column — about 74 characters, which is the measurement
// the whole layout is built to protect.
const serif = Literata({
  subsets: ["latin", "latin-ext"],
  variable: "--font-serif",
  display: "swap",
});

// JetBrains Mono for anything that has to line up in a column. The V2 design
// specified Geist Mono, which is narrower and reads less like a code editor
// beside a name — but it is not in Next 14's Google Fonts data, and a
// self-hosted family for that much of a gain is not worth the first-paint cost.
// See docs/v2-implementation/implementation-notes.md.
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Reverie AI — Meeting summaries & action items",
  description:
    "Turn meeting audio into accurate transcripts, concise summaries, and trackable action items.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${serif.variable} ${mono.variable}`}
    >
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
