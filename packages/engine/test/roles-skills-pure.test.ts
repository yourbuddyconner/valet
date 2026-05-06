import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import {
  loadRoleFromMarkdown,
  loadSkillFromMarkdown,
  parseMarkdownArtifact,
  renderTemplate,
} from "../src/index.js";

describe("parseMarkdownArtifact", () => {
  it("returns body unchanged when there's no frontmatter", () => {
    const r = parseMarkdownArtifact("# Hello\n\nNo frontmatter.");
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe("# Hello\n\nNo frontmatter.");
  });

  it("parses simple key:value frontmatter", () => {
    const r = parseMarkdownArtifact(`---
name: github
description: GitHub skill
---

# Body
`);
    expect(r.frontmatter).toEqual({ name: "github", description: "GitHub skill" });
    expect(r.body).toBe("# Body\n");
  });

  it("strips matching surrounding quotes", () => {
    const r = parseMarkdownArtifact(`---
name: "quoted name"
description: 'single-quoted'
---
body
`);
    expect(r.frontmatter.name).toBe("quoted name");
    expect(r.frontmatter.description).toBe("single-quoted");
  });

  it("coerces booleans and numbers", () => {
    const r = parseMarkdownArtifact(`---
enabled: true
disabled: false
count: 42
ratio: 1.5
---
x
`);
    expect(r.frontmatter.enabled).toBe(true);
    expect(r.frontmatter.disabled).toBe(false);
    expect(r.frontmatter.count).toBe(42);
    expect(r.frontmatter.ratio).toBe(1.5);
  });

  it("ignores comment and empty lines in frontmatter", () => {
    const r = parseMarkdownArtifact(`---
# this is a comment
name: x

description: y
---
b
`);
    expect(r.frontmatter).toEqual({ name: "x", description: "y" });
  });

  it("returns content as body when frontmatter is unclosed", () => {
    const r = parseMarkdownArtifact(`---
name: nope
no closing fence here
`);
    expect(r.frontmatter).toEqual({});
    expect(r.body).toContain("name: nope");
  });
});

describe("renderTemplate", () => {
  it("substitutes simple {{name}} placeholders", () => {
    expect(renderTemplate("Hello {{name}}", { name: "world" })).toBe("Hello world");
  });

  it("allows whitespace inside braces", () => {
    expect(renderTemplate("Hello {{ name }}!", { name: "x" })).toBe("Hello x!");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(renderTemplate("a {{missing}} b", { other: 1 })).toBe("a {{missing}} b");
  });

  it("renders null/undefined as empty string", () => {
    expect(renderTemplate("[{{a}}][{{b}}]", { a: undefined, b: null })).toBe("[][]");
  });

  it("does not interpret nested braces", () => {
    expect(renderTemplate("{{x.y}} {{1bad}}", { "x.y": "broken", "1bad": "broken" })).toBe(
      "{{x.y}} {{1bad}}",
    );
  });
});

describe("loadRoleFromMarkdown", () => {
  it("builds a RoleSpec from frontmatter + body", () => {
    const role = loadRoleFromMarkdown(`---
name: reviewer
description: Code reviewer persona
model: claude-haiku-4-5
---

You are a careful code reviewer.
`);
    expect(role).toMatchObject({
      name: "reviewer",
      description: "Code reviewer persona",
      model: "claude-haiku-4-5",
      source: "session",
    });
    expect(role.content.startsWith("You are a careful code reviewer.")).toBe(true);
  });

  it("throws when name is missing and no fallback supplied", () => {
    expect(() => loadRoleFromMarkdown("# no frontmatter")).toThrow(/name is required/);
  });

  it("uses fallback name when frontmatter omits it", () => {
    const r = loadRoleFromMarkdown("# body", "plugin", "fallback");
    expect(r.name).toBe("fallback");
    expect(r.source).toBe("plugin");
  });
});

describe("loadSkillFromMarkdown", () => {
  it("builds a SkillSource and accepts an explicit argsSchema", () => {
    const schema = Type.Object({ topic: Type.String() });
    const skill = loadSkillFromMarkdown(
      `---
name: research
description: Research a topic
---

Research {{topic}} and report back.
`,
      "plugin",
      undefined,
      schema,
    );
    expect(skill).toMatchObject({
      name: "research",
      description: "Research a topic",
      source: "plugin",
      argsSchema: schema,
    });
    expect(skill.content).toContain("Research {{topic}}");
  });
});
