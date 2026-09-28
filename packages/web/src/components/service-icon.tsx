/**
 * The avatar a service, plugin, or skill card shows — a vendor's brand mark
 * when one exists, a lucide glyph for a plugin Valet ships itself, and the
 * initial-letter monogram when neither applies.
 *
 * Why a mark at all: the monogram alone printed one grey letter per card,
 * and Gmail, Google Calendar, and Google Workspace all print "G". Six cards
 * in the Services grid were indistinguishable at a glance.
 *
 * WHERE THE PATHS COME FROM: `simple-icons`, the upstream brand-mark set.
 * The path data is never written here. Each mark is imported by name, so
 * the bundle carries the marks this file names and no others.
 *
 * COLOR: each mark renders in `currentColor`, not in the vendor's brand
 * hex. A brand hex is one fixed colour; the app has a light theme and a
 * dark theme, and a mark like GitHub's near-black disappears on the dark
 * paper. `currentColor` follows the theme token instead, so a mark keeps
 * its contrast in both.
 *
 * FIRST-PARTY PLUGINS take a lucide glyph instead of a mark. Workflows,
 * skills, the browser, assistants, and sandbox tunnels are capabilities Valet
 * writes itself, so no vendor mark for them exists or ever will, and a
 * letter tile teaches the reader nothing about what the plugin does.
 *
 * The MONOGRAM fallback keeps the brand hue as a tile BACKGROUND with white
 * text, which holds contrast in both themes for the same reason a badge
 * does. It is the exception now: only a vendor the upstream set carries no
 * mark for lands here — Slack, DeepWiki, and Typefully at time of writing.
 * Do not reach for `siSlack`. `simple-icons` has no Slack mark, only
 * `siSlackware`, so Slack's letter tile is deliberate and not an oversight.
 */
import { Cable, Drama, Globe, GraduationCap, Workflow, type LucideIcon } from "lucide-react";
import {
  si1password,
  siCloudflare,
  siFigma,
  siGithub,
  siGmail,
  siGooglecalendar,
  siGoogledocs,
  siGoogledrive,
  siGooglesheets,
  siLinear,
  siNotion,
  siSentry,
  siStripe,
  siTelegram,
} from "simple-icons";
import { cn } from "~/lib/cn";

/** The two fields a mark needs to render. `simple-icons` entries carry more
 * (brand hex, source URL, the full SVG string); this file uses the outline
 * and the brand name only. */
interface BrandMark {
  title: string;
  path: string;
}

/**
 * Slug → mark. Keys are the slugs plugins declare in `plugin.yaml`
 * (`iconSlug`, shipped on `PluginServiceSummary.iconSlug`), plus the plugin
 * ids callers fall back to when a plugin declares no slug of its own.
 */
const BRAND_MARKS: Record<string, BrandMark> = {
  "1password": si1password,
  onepassword: si1password,
  cloudflare: siCloudflare,
  figma: siFigma,
  github: siGithub,
  gmail: siGmail,
  "google-calendar": siGooglecalendar,
  google_calendar: siGooglecalendar,
  "google-docs": siGoogledocs,
  "google-drive": siGoogledrive,
  "google-sheets": siGooglesheets,
  // The Google Workspace plugin reaches Drive, Docs, and Sheets through one
  // credential. Drive is the store the other two write into, so it stands
  // for the set.
  "google-workspace": siGoogledrive,
  google_workspace: siGoogledrive,
  linear: siLinear,
  notion: siNotion,
  sentry: siSentry,
  stripe: siStripe,
  telegram: siTelegram,
};

/** The mark for a slug, or `undefined` when the set has none for it. */
export function brandMark(slug: string | undefined): BrandMark | undefined {
  if (!slug) return undefined;
  return BRAND_MARKS[slug];
}

/**
 * Slug → lucide glyph, for the plugins Valet ships itself. These name no
 * vendor, so `simple-icons` will never carry a mark for one, and the glyph
 * is what tells a reader that the row is a capability and which capability
 * it is.
 *
 * Each plugin holds TWO keys, because the id reaching this file depends on
 * the caller. `/integrations` falls back to the plugin name the wire ships
 * (`workflows-actions`, `skills-actions`) for a plugin that declares no
 * credential; a workflow template card names the action service it needs
 * (`workflows`, `skills`); `/skills` names the plugin a skill came from
 * (`browser`, `assistants`, `sandbox-tunnels`).
 */
const PLUGIN_GLYPHS: Record<string, LucideIcon> = {
  // A real Chromium the agent drives.
  browser: Globe,
  // Who the assistant is being; the manifest picks theatre masks too.
  assistants: Drama,
  // A wire out of the sandbox to a public hostname.
  "sandbox-tunnels": Cable,
  skills: GraduationCap,
  "skills-actions": GraduationCap,
  workflows: Workflow,
  "workflows-actions": Workflow,
};

/** The glyph for a first-party slug, or `undefined` when the slug names a
 * vendor or a plugin nobody here wrote. */
export function pluginGlyph(slug: string | undefined): LucideIcon | undefined {
  if (!slug) return undefined;
  return PLUGIN_GLYPHS[slug];
}

/** Recognizable brand hues for the monogram tile; unknown services hash
 * into a small default palette so third-party plugins still get a stable
 * color. Full-strength hexes on purpose — the CSS-var tokens can't take
 * opacity modifiers (theme.css trap).
 *
 * A service that already draws a mark keeps its hue listed. A brand can
 * leave the upstream set — Slack did — and its import has to leave this
 * file with it; the hue is what the card falls back to that day. First-party
 * plugins hold no hue, because `PLUGIN_GLYPHS` always answers for them. */
const BRAND_HEX: Record<string, string> = {
  "1password": "#1a1917",
  onepassword: "#1a1917",
  github: "#24292f",
  gmail: "#ea4335",
  "google-calendar": "#4285f4",
  google_calendar: "#4285f4",
  "google-workspace": "#34a853",
  google_workspace: "#34a853",
  slack: "#611f69",
  linear: "#5e6ad2",
  notion: "#111111",
  sentry: "#362d59",
  stripe: "#635bff",
  cloudflare: "#f6821f",
  deepwiki: "#0ea5e9",
  typefully: "#1d9bf0",
  telegram: "#229ed9",
  figma: "#a259ff",
};

const FALLBACK_HEX = ["#0ea5e9", "#f97316", "#8b5cf6", "#f43f5e", "#14b8a6", "#6366f1"];

export function brandHex(id: string): string {
  const known = BRAND_HEX[id];
  if (known) return known;
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return FALLBACK_HEX[Math.abs(h) % FALLBACK_HEX.length];
}

/**
 * `brand` is the default. `quiet` dims a built-in plugin, which asks
 * nothing of the reader. `accent` marks a skill the caller stores, which
 * belongs to no vendor and therefore never takes a mark.
 */
export type ServiceIconTone = "brand" | "quiet" | "accent";

/**
 * `md` is the card avatar. `sm` is the inline scale, for a run of marks read
 * as one line — the app chain on a workflow template card, where the tile
 * sits beside body text rather than heading it.
 */
export type ServiceIconSize = "sm" | "md";

export interface ServiceIconProps {
  /** Brand slug (`PluginServiceSummary.iconSlug`) or, with no slug on the
   * wire, the plugin or service id. */
  slug?: string;
  /** The name beside the icon. The monogram takes its first letter. */
  label: string;
  tone?: ServiceIconTone;
  size?: ServiceIconSize;
  className?: string;
}

const TILE = "grid shrink-0 place-items-center";
const TILE_SIZE: Record<ServiceIconSize, string> = {
  sm: "h-6 w-6 rounded-md",
  md: "h-9 w-9 rounded-lg",
};
/** The mark insets within its tile; the monogram fills it. */
const MARK_SIZE: Record<ServiceIconSize, string> = {
  sm: "h-3.5 w-3.5",
  md: "h-5 w-5",
};
const MONOGRAM_SIZE: Record<ServiceIconSize, string> = {
  sm: "text-[11px]",
  md: "text-sm",
};

export function ServiceIcon({
  slug,
  label,
  tone = "brand",
  size = "md",
  className,
}: ServiceIconProps) {
  // A stored skill answers to its author, not to a vendor or a plugin, so
  // the accent tone skips both registries and keeps its own tile.
  const mark = tone === "accent" ? undefined : brandMark(slug);
  const Glyph = tone === "accent" || mark ? undefined : pluginGlyph(slug);

  // A mark is a filled outline the vendor drew; a glyph is a lucide stroke
  // drawing. Both sit in the same wash tile, so a row of them reads as one
  // set rather than two.
  const icon = mark ? (
    <svg viewBox="0 0 24 24" fill="currentColor" className={MARK_SIZE[size]} focusable="false">
      <path d={mark.path} />
    </svg>
  ) : Glyph ? (
    <Glyph className={MARK_SIZE[size]} focusable="false" />
  ) : null;

  // Decorative: the service name is always beside it in text, so a screen
  // reader that read the icon too would say the name twice.
  if (icon) {
    return (
      <span
        aria-hidden="true"
        data-brand-mark={mark ? slug : undefined}
        data-plugin-glyph={Glyph ? slug : undefined}
        className={cn(
          TILE,
          TILE_SIZE[size],
          "bg-ink-wash",
          tone === "quiet" ? "text-muted" : "text-ink",
          className,
        )}
      >
        {icon}
      </span>
    );
  }

  const background =
    tone === "quiet" ? "#a8a29b" : tone === "accent" ? undefined : brandHex(slug ?? label);
  return (
    <span
      aria-hidden="true"
      className={cn(
        TILE,
        TILE_SIZE[size],
        MONOGRAM_SIZE[size],
        "font-semibold text-white",
        tone === "accent" && "bg-moss",
        className,
      )}
      style={background ? { backgroundColor: background } : undefined}
    >
      {label.charAt(0).toUpperCase()}
    </span>
  );
}
