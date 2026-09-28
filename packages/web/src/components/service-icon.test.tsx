// @vitest-environment jsdom
/**
 * `ServiceIcon`: real brand marks where the upstream set has one, a lucide
 * glyph for the plugins Valet ships itself, and the initial-letter monogram
 * where neither applies.
 *
 * The bug this guards: every card printed one letter, so GitHub, Gmail,
 * Google Calendar, Google Docs, Google Drive, and Google Sheets were six
 * identical circles. The first test therefore compares the RENDERED PATH
 * DATA across those services — same-looking marks would fail it.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ServiceIcon, brandHex, brandMark, pluginGlyph } from "./service-icon";

/** The `d` of the single path a mark draws, or null when the icon fell back
 * to the monogram. */
function markPath(container: HTMLElement): string | null {
  return container.querySelector("svg path")?.getAttribute("d") ?? null;
}

/** True when the tile drew a letter rather than any icon. A glyph draws an
 * `<svg>` too, so the letter is what separates the fallback from both. */
function isMonogram(container: HTMLElement): boolean {
  return container.querySelector("svg") === null;
}

describe("ServiceIcon brand marks", () => {
  it("draws a different mark for every service that shares an initial", () => {
    const slugs = ["github", "gmail", "google-calendar", "google-docs", "google-drive", "google-sheets"];
    const paths = slugs.map((slug) => {
      const { container } = render(<ServiceIcon slug={slug} label={slug} />);
      const path = markPath(container);
      expect(path, `${slug} has no mark`).toBeTruthy();
      return path;
    });
    expect(new Set(paths).size).toBe(slugs.length);
  });

  it("draws the mark in currentColor so it follows the theme", () => {
    const { container } = render(<ServiceIcon slug="github" label="GitHub" />);
    expect(container.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
    // No inline background either: a mark tile takes theme tokens, and only
    // the monogram fallback paints a brand hue.
    expect(container.querySelector("span")?.getAttribute("style")).toBeNull();
  });

  it("hides the icon from assistive technology, which reads the name beside it", () => {
    const { container } = render(<ServiceIcon slug="linear" label="Linear" />);
    expect(container.querySelector("span")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("maps a plugin id with no declared slug of its own", () => {
    // `google-workspace` reaches Drive, Docs, and Sheets through one
    // credential; the card falls back to the plugin id when the wire ships
    // no slug.
    expect(brandMark("google-workspace")).toBeDefined();
    expect(brandMark("google-workspace")?.path).toBe(brandMark("google-drive")?.path);
  });

  it("draws the vendors the upstream set does carry", () => {
    // Stripe reads as a monogram candidate beside Slack, which has no mark.
    // It is not one: `simple-icons` ships Stripe, so the card must draw it.
    for (const slug of ["stripe", "sentry", "telegram", "cloudflare", "notion"]) {
      const { container } = render(<ServiceIcon slug={slug} label={slug} />);
      expect(markPath(container), `${slug} lost its mark`).toBeTruthy();
    }
  });
});

describe("ServiceIcon first-party glyphs", () => {
  it("draws a glyph, not a letter, for every plugin Valet ships itself", () => {
    // `/integrations` names a credential-less plugin by the name the wire
    // ships; a template card and `/skills` name the service or the plugin.
    // All three ids reach here, so all three must resolve.
    const slugs = [
      "workflows",
      "workflows-actions",
      "skills",
      "skills-actions",
      "browser",
      "assistants",
      "sandbox-tunnels",
    ];
    for (const slug of slugs) {
      const { container } = render(<ServiceIcon slug={slug} label={slug} />);
      expect(isMonogram(container), `${slug} fell back to a letter`).toBe(false);
      expect(container.querySelector("[data-plugin-glyph]")).toBeTruthy();
      expect(container.textContent).toBe("");
    }
  });

  it("tells the two action surfaces apart", () => {
    // Both are "S"-and-"W" rows on `/integrations`; the glyph is the only
    // thing that says which capability a row is.
    expect(pluginGlyph("skills-actions")).not.toBe(pluginGlyph("workflows-actions"));
    expect(pluginGlyph("skills-actions")).toBe(pluginGlyph("skills"));
    expect(pluginGlyph("workflows-actions")).toBe(pluginGlyph("workflows"));
  });

  it("gives a glyph tile the same theme treatment as a mark tile", () => {
    // No inline brand hue: only the monogram paints one, and a glyph tile
    // has to follow the theme token in both light and dark.
    const { container } = render(<ServiceIcon slug="workflows-actions" label="Workflows actions" />);
    expect(container.querySelector("span")?.getAttribute("style")).toBeNull();
    expect(container.querySelector("span")?.className).toContain("bg-ink-wash");
  });

  it("holds no glyph for a vendor", () => {
    expect(pluginGlyph("slack")).toBeUndefined();
    expect(pluginGlyph("github")).toBeUndefined();
    expect(pluginGlyph(undefined)).toBeUndefined();
  });
});

describe("ServiceIcon monogram fallback", () => {
  it("falls back to the initial for a service the upstream set has no mark for", () => {
    // These three are the whole fallback set on `/integrations`.
    // `simple-icons` carries no Slack mark (only Slackware), and DeepWiki
    // and Typefully are absent from it as well. Each is a vendor, so no
    // lucide glyph stands in either — the letter is the honest answer.
    for (const { slug, label } of [
      { slug: "slack", label: "Slack" },
      { slug: "deepwiki", label: "DeepWiki" },
      { slug: "typefully", label: "Typefully" },
    ]) {
      const { container } = render(<ServiceIcon slug={slug} label={label} />);
      expect(isMonogram(container), `${slug} unexpectedly drew an icon`).toBe(true);
      expect(container.textContent).toBe(label.charAt(0));
    }
  });

  it("falls back for an unknown slug and for no slug at all", () => {
    const unknown = render(<ServiceIcon slug="acme-tickets" label="Acme tickets" />);
    expect(markPath(unknown.container)).toBeNull();
    expect(unknown.container.textContent).toBe("A");

    const none = render(<ServiceIcon label="Deploy notes" />);
    expect(markPath(none.container)).toBeNull();
    expect(none.container.textContent).toBe("D");
  });

  it("paints a hue behind the letter, and a different hue per service", () => {
    // jsdom reports the computed `rgb(...)`, so read the two tiles against
    // each other rather than against the source hex.
    const slack = render(<ServiceIcon slug="slack" label="Slack" />);
    const typefully = render(<ServiceIcon slug="typefully" label="Typefully" />);
    const hue = (root: HTMLElement) => root.querySelector("span")?.style.backgroundColor;
    expect(hue(slack.container)).toBeTruthy();
    expect(hue(slack.container)).not.toBe(hue(typefully.container));
    // Unknown ids hash into the fallback palette — stable across renders.
    expect(brandHex("acme-tickets")).toBe(brandHex("acme-tickets"));
    expect(brandHex("slack")).toBe("#611f69");
  });

  it("keeps the accent tone free of any brand mark or glyph", () => {
    // A stored skill belongs to no vendor and to no plugin, so it takes the
    // accent tile even when its name collides with a registered slug.
    const vendor = render(<ServiceIcon slug="github" label="Github notes" tone="accent" />);
    expect(isMonogram(vendor.container)).toBe(true);
    expect(vendor.container.querySelector("span")?.className).toContain("bg-moss");

    const firstParty = render(<ServiceIcon slug="workflows" label="Workflow notes" tone="accent" />);
    expect(isMonogram(firstParty.container)).toBe(true);
    expect(firstParty.container.querySelector("span")?.className).toContain("bg-moss");
  });
});
