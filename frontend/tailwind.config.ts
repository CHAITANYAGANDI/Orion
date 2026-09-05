import type { Config } from "tailwindcss";

/*
 * The V2 design system, as Tailwind theme values.
 *
 * Every colour here points at a variable in app/globals.css. Nothing is a
 * literal, and there is no second palette: the shadcn names (background, card,
 * border, primary…) and the V2 names (surface-*, ink-*, brand-*) are two sets
 * of aliases over one set of values, which is what lets a screen that has not
 * been rebuilt yet still look like it belongs.
 *
 * See docs/v2-implementation/feature-parity.md for what is being migrated and
 * in what order.
 */
const config: Config = {
  // No dark variant, because there is no light one to vary from. The palette is
  // a single set of variables on :root; a `dark:` utility would compile to a
  // rule keyed on a class nothing adds, and so would silently never apply.
  darkMode: [],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      screens: {
        // The width below which the margin can no longer hold a citation
        // without wrapping a speaker's name. See `.v2-spread`.
        spread: "1160px",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        serif: ["var(--font-serif)", "ui-serif", "Georgia", "serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      fontSize: {
        // Eleven interface steps, each with a job. Not twenty-five arbitrary
        // sizes — and body/headline share a size at two weights, which is a
        // real hierarchy level that costs no vertical rhythm.
        display: ["var(--t-display)", { lineHeight: "1.06", letterSpacing: "-0.022em" }],
        "title-l": ["var(--t-title-l)", { lineHeight: "1.14", letterSpacing: "-0.018em" }],
        "title-1": ["var(--t-title-1)", { lineHeight: "1.22", letterSpacing: "-0.012em" }],
        "title-2": ["var(--t-title-2)", { lineHeight: "1.3", letterSpacing: "-0.006em" }],
        "title-3": ["var(--t-title-3)", { lineHeight: "1.35" }],
        body: ["var(--t-body)", { lineHeight: "1.5" }],
        callout: ["var(--t-callout)", { lineHeight: "1.5" }],
        foot: ["var(--t-foot)", { lineHeight: "1.45" }],
        cap: ["var(--t-cap)", { lineHeight: "1.3", letterSpacing: "0.04em" }],
        read: ["var(--t-read)", { lineHeight: "var(--lh-read)" }],
      },
      fontWeight: {
        // The two the interface actually uses. 420 rather than 400 because
        // Schibsted at 400 is slightly light on this ground; 560 rather than
        // 600 because 600 competes with a title at the same size.
        body: "420",
        headline: "560",
      },
      colors: {
        // ---- shadcn names, repointed -------------------------------------
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        highlight: {
          DEFAULT: "hsl(var(--highlight))",
          foreground: "hsl(var(--highlight-foreground))",
        },

        // ---- V2 names, for new and rebuilt components ---------------------
        surface: {
          DEFAULT: "hsl(var(--surface))",
          raised: "hsl(var(--surface-raised))",
          overlay: "hsl(var(--surface-overlay))",
          hover: "hsl(var(--surface-hover))",
          selected: "hsl(var(--surface-selected))",
        },
        // Four usable tiers and a fifth that may not carry meaning. ink-5 is
        // decorative only — a spine, a separator glyph, a pip. Never a word a
        // person needs to read.
        ink: {
          DEFAULT: "hsl(var(--ink))",
          2: "hsl(var(--ink-2))",
          3: "hsl(var(--ink-3))",
          4: "hsl(var(--ink-4))",
          5: "hsl(var(--ink-5))",
        },
        // One accent, and it does not mean "primary". It means: Reverie
        // noticed this, or Reverie is doing this.
        brand: {
          DEFAULT: "hsl(var(--brand))",
          text: "hsl(var(--brand-text))",
          fill: "hsl(var(--brand-fill))",
          hover: "hsl(var(--brand-hover))",
          deep: "hsl(var(--brand-deep))",
        },
        danger: {
          DEFAULT: "hsl(var(--danger))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        // Translucent white, so one value works over every surface.
        line: {
          DEFAULT: "rgb(var(--line))",
          strong: "rgb(var(--line-strong))",
        },
        // The visible boundary of anything operable. 3:1 is a WCAG floor
        // (1.4.11), not a style choice.
        edge: {
          DEFAULT: "rgb(var(--edge))",
          hover: "rgb(var(--edge-hover))",
        },
      },
      borderRadius: {
        xs: "var(--r-xs)",
        sm: "calc(var(--radius) - 2px)",
        md: "var(--radius)",
        lg: "var(--r-md)",
        xl: "var(--r-lg)",
        "2xl": "var(--r-xl)",
      },
      boxShadow: {
        // Short and dark. The half-pixel white inset is what actually
        // separates a floating layer from content.
        e1: "var(--e-1)",
        e2: "var(--e-2)",
        e3: "var(--e-3)",
        e4: "var(--e-4)",
      },
      spacing: {
        band: "var(--band)",
        measure: "var(--measure)",
        margincol: "var(--margin-col)",
        doc: "var(--doc)",
      },
      maxWidth: {
        measure: "var(--measure)",
        doc: "var(--doc)",
      },
      transitionDuration: {
        press: "var(--m-press)",
        pop: "var(--m-pop)",
        panel: "var(--m-panel)",
        modal: "var(--m-modal)",
      },
      transitionTimingFunction: {
        // Decelerate: fast out of the gate, settling rather than stopping.
        out: "var(--ease)",
        // Symmetric, for anything that only changes opacity or colour — a fade
        // has no momentum and should not pretend to.
        soft: "var(--ease-soft)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        // A slow breath rather than a shimmer sweeping the screen every 1.2
        // seconds. Skeletons are structural here.
        breathe: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.62" },
        },
        // The recording lamp. The one place a filled shape and an animation
        // are both justified: the cost of not noticing is recording something
        // you did not mean to.
        recpulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.34" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        breathe: "breathe 2.4s var(--ease-soft) infinite",
        recpulse: "recpulse 2s var(--ease-soft) infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
