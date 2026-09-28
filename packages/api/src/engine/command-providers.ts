import { createHash } from "node:crypto";
/**
 * Host-side providers for the slash-command subsystem (slash-commands plan,
 * Task 10; skills-as-commands plan, Task 4). These adapt app data (Drizzle, the
 * org model catalog, child-session links) into the engine's injection
 * contracts:
 *
 *  - `makeWorkspaceSkillsProvider` — a `() => Promise<SkillSource[]>` provider
 *    that reads repo prompt skills from the session's prepared sandbox
 *    (`/workspace/.valet/prompts/*.md`). Each file becomes an
 *    `invocation: "prompt"` skill. DB-stored prompt skills reach a session
 *    through `sessionExtras` → `options.skills`, not through this provider.
 *  - `makeCommandContext` — `CommandContext`, backing `/model` (the org model
 *    catalog) and `/sessions` (this session's children).
 *
 * The engine owns the registry and dispatch; these only supply data it cannot
 * reach on its own.
 */
import { desc, eq } from "drizzle-orm";
import type {
  CommandContext,
  Sandbox,
  SkillSource,
} from "@valet/engine";
import type { CredentialStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, childWatches } from "../schema/index.js";
import { buildOrgCatalog } from "../services/model-catalog.js";

/** Where repo prompt skills live inside a prepared workspace. */
const REPO_PROMPTS_GLOB = "/workspace/.valet/prompts/*.md";

/** Delimiter the repo-prompt exec prints before each file's content. */
const TMPL_DELIM = "===VALET-TMPL ";

/**
 * One exec that dumps every `/workspace/.valet/prompts/*.md` file, each
 * preceded by a `===VALET-TMPL <path>` line. `readRepoPromptSkills` parses the
 * combined stdout on that delimiter. A single exec (not one per file) keeps the
 * round-trip count fixed regardless of how many prompt skills a repo carries.
 */
const REPO_PROMPT_EXEC = `sh -c 'for f in ${REPO_PROMPTS_GLOB}; do [ -f "$f" ] || continue; printf "${TMPL_DELIM}%s\\n" "$f"; cat "$f"; done'`;

/**
 * Reads repo prompt skills from a prepared sandbox. Returns `[]` when:
 *  - no sandbox is available (the accessor returned `undefined` — e.g. the
 *    attachment is not `ready`, so listing must not provision one), or
 *  - the exec exits non-zero (no matching files, or the shell is unavailable).
 *
 * `name` is the filename without its `.md` suffix. `description` and `argHint`
 * are read from a leading frontmatter block when present. `invocation` defaults
 * to `"prompt"` but honors an explicit `invocation:` frontmatter override.
 */
export async function readRepoPromptSkills(sandbox: Sandbox | undefined): Promise<SkillSource[]> {
  if (!sandbox) return [];
  let stdout: string;
  try {
    const result = await sandbox.exec(REPO_PROMPT_EXEC);
    if (result.exitCode !== 0) return [];
    stdout = result.stdout;
  } catch {
    // A sandbox that rejects the exec (transient provisioning race, unusual
    // shell) yields no repo prompt skills rather than failing the whole
    // listing.
    return [];
  }
  return parseRepoPromptSkills(stdout);
}

/** Parses the delimited stdout of `REPO_PROMPT_EXEC` into prompt skills. */
function parseRepoPromptSkills(stdout: string): SkillSource[] {
  const skills: SkillSource[] = [];
  // Split on the delimiter; the first chunk is whatever preceded the first
  // marker (empty for well-formed output) and is skipped.
  const chunks = stdout.split(TMPL_DELIM);
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    const newlineIdx = chunk.indexOf("\n");
    if (newlineIdx === -1) continue;
    const path = chunk.slice(0, newlineIdx).trim();
    const content = chunk.slice(newlineIdx + 1);
    const base = path.slice(path.lastIndexOf("/") + 1);
    const name = base.endsWith(".md") ? base.slice(0, -3) : base;
    if (!name) continue;
    const fm = readFrontmatter(content);
    skills.push({
      name,
      ...(fm.description ? { description: fm.description } : {}),
      ...(fm.argHint ? { argHint: fm.argHint } : {}),
      content,
      source: "repo",
      key: `repo:${name}`,
      contentSha: createHash("sha256").update(content).digest("hex"),
      origin: "repo",
      invocation: fm.invocation === "context" ? "context" : "prompt",
    });
  }
  return skills;
}

interface RepoFrontmatter {
  description?: string;
  argHint?: string;
  invocation?: string;
}

/**
 * Extracts `description`, `argHint`, and `invocation` from a leading
 * frontmatter block. Supports both a fenced `---` block and a bare leading
 * `key: value` block, so a minimally-tagged prompt still gets its fields.
 * Scanning stops at the first non-frontmatter line.
 */
function readFrontmatter(content: string): RepoFrontmatter {
  const fm: RepoFrontmatter = {};
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "---") continue;
    const match = trimmed.match(/^([A-Za-z][\w-]*):\s*(.+)$/);
    if (!match) break; // First non-frontmatter, non-empty line ends the block.
    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (key === "description") fm.description = value;
    else if (key === "arghint") fm.argHint = value;
    else if (key === "invocation") fm.invocation = value;
  }
  return fm;
}

/**
 * Builds the workspace-skills provider for a session. Serves repo prompt skills
 * read from the session's sandbox (`/workspace/.valet/prompts/*.md`).
 *
 * `sandbox()` resolves the session's sandbox handle lazily and returns
 * `undefined` when no prepared sandbox is available — the host guards it so a
 * `GET /commands` call never provisions a sandbox just to list prompts.
 */
export function makeWorkspaceSkillsProvider(
  sandbox: () => Sandbox | undefined,
): () => Promise<SkillSource[]> {
  return async (): Promise<SkillSource[]> => {
    return readRepoPromptSkills(sandbox());
  };
}

/**
 * Builds the `CommandContext` for a session.
 *
 * `listModels` reuses `buildOrgCatalog` — the same enumeration `GET /api/models`
 * serves — filtered to the picker-visible (active) set, mapped to `{ id, name }`.
 *
 * `listChildSessions` joins `child_watches` to `agent_sessions` for this
 * session's children (the same source `GET /api/sessions/:sessionId/children` reads),
 * newest first. `status` is `"settled"` or `"running"`, mirroring that route.
 */
export function makeCommandContext(
  db: AppDb,
  credentials: CredentialStore,
  orgId: string,
  sessionId: string,
): CommandContext {
  return {
    async listModels(): Promise<Array<{ id: string; name: string }>> {
      const entries = await buildOrgCatalog(db, credentials, orgId);
      return entries.filter((e) => e.active).map((e) => ({ id: e.id, name: e.name }));
    },
    async listChildSessions(): Promise<Array<{ id: string; title?: string; status: string }>> {
      const rows = await db
        .select({
          childSessionId: childWatches.childSessionId,
          settled: childWatches.settled,
          title: agentSessions.title,
        })
        .from(childWatches)
        .innerJoin(agentSessions, eq(agentSessions.id, childWatches.childSessionId))
        .where(eq(childWatches.parentSessionId, sessionId))
        .orderBy(desc(childWatches.createdAt));
      return rows.map((r) => ({
        id: r.childSessionId,
        title: r.title ?? undefined,
        status: r.settled ? "settled" : "running",
      }));
    },
  };
}
