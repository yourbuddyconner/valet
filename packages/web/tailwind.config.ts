import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

/**
 * Design tokens — single source of truth for color, radius, spacing, type.
 * Components consume these via Tailwind class names; we don't hand-pick raw
 * hex values in components.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Neutral grayscale, OKLCH-tuned for even visual steps. Used for
        // backgrounds, borders, secondary text. Names map to Tailwind's
        // expected scale so we get the standard shade utilities.
        neutral: {
          50:  "oklch(98.5% 0.002 247)",
          100: "oklch(96.7% 0.003 247)",
          200: "oklch(92.9% 0.005 247)",
          300: "oklch(86.9% 0.007 247)",
          400: "oklch(70.7% 0.012 247)",
          500: "oklch(55.4% 0.015 247)",
          600: "oklch(44.6% 0.013 247)",
          700: "oklch(37.2% 0.010 247)",
          800: "oklch(27.8% 0.008 247)",
          900: "oklch(20.5% 0.006 247)",
          950: "oklch(13.0% 0.005 247)",
        },
        accent: {
          50:  "oklch(97.0% 0.025 264)",
          100: "oklch(93.2% 0.045 264)",
          500: "oklch(60.5% 0.180 264)",
          600: "oklch(53.5% 0.190 264)",
          700: "oklch(46.5% 0.180 264)",
        },
        danger: {
          500: "oklch(60.0% 0.220 27)",
          600: "oklch(53.0% 0.220 27)",
        },
        success: {
          500: "oklch(65.0% 0.150 145)",
          600: "oklch(57.0% 0.150 145)",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      borderRadius: {
        sm: "0.25rem",
        DEFAULT: "0.375rem",
        md: "0.5rem",
        lg: "0.75rem",
      },
      animation: {
        "spin-slow": "spin 1.6s linear infinite",
      },
    },
  },
  plugins: [typography],
} satisfies Config;
