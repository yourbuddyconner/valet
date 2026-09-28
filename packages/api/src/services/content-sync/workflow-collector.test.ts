import linearEventPlugin from "@valet/plugin-linear/plugin";
/**
 * The workflow collector, driven through `syncOnce` — the same entry point
 * the skills collector runs under, against the same GitHub fixture.
 *
 * The cases that matter most are the ones about NOT writing: a transport
 * failure, a cut tree, and a file that stopped parsing all leave the mirrored
 * rows alone. A mirror that loses a working workflow because someone pushed a
 * typo is worse than a mirror that lags a commit.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../../lib/drizzle.js";
import { freshTestPgDb } from "../../test-helpers/pg-test-db.js";
import {
  commitBody,
  startGithubFixture,
  treeEntry,
  type GithubFixture,
} from "../../test-helpers/github-fixture.js";
import {
  linearInstallations,
  contentSources,
  eventSubscriptions,
  orgMembers,
  orgs,
  teamMembers,
  teams,
  users,
  workflowDefinitions,
  workflowRuns,
  workflowSchedules,
  workflowVersions,
} from "../../schema/index.js";
import { addMember, removeMember } from "../teams.js";
import { createContentSource } from "../content-sources.js";
import { GitHubSkillRepoReader } from "../skill-repo-reader.js";
import { ContentSyncService } from "./service.js";
import { SkillCollector } from "./skill-collector.js";
import { WorkflowCollector } from "./workflow-collector.js";
import githubPlugin from "@valet/plugin-github/plugin";
import { InMemoryCredentialStore, type CredentialStore, type ValetPlugin } from "@valet/engine";

const ORG = "org1";
const TEAM = "team_1";

/** The smallest graph the dag/v1 validator accepts. */
const GRAPH = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "stop", type: "stop" },
  ],
  edges: [{ from: "trigger", to: "stop" }],
};

/** A workflow file in the envelope form the design documents. `end` names
 * the stop node, so a second call produces a different graph without needing
 * a node type that carries more fields. */
function workflowYaml(name: string, end = "stop"): string {
  return [
    "valet: workflow/v1",
    `name: ${name}`,
    "definition:",
    "  version: dag/v1",
    "  nodes:",
    "    - id: trigger",
    "      type: trigger",
    `    - id: ${end}`,
    "      type: stop",
    "  edges:",
    "    - from: trigger",
    `      to: ${end}`,
    "",
  ].join("\n");
}

let fixture: GithubFixture | undefined;

function blobShaOf(content: string): string {
  return `blob-${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12)}`;
}

interface FakeRepo {
  sha: string;
  /** Every file, keyed by path from the repository root. */
  files: Record<string, string>;
  truncatedTree?: boolean;
  /** Every request after this many fails, playing a GitHub outage. */
  failAfter?: number;
  /** Paths the TREE lists and the contents endpoint answers 404 for. This is
   * a real window: the tree read and the file reads are separate calls, and a
   * file can go between them. */
  unreadable?: string[];
}

function serve(repo: FakeRepo): GithubFixture {
  const failed = { status: 500 as const, body: { message: "Server Error" } };
  const down = (): boolean =>
    repo.failAfter !== undefined && (fixture?.calls.length ?? 0) > repo.failAfter;
  fixture = startGithubFixture({
    getCommit: () => (down() ? failed : { body: commitBody(repo.sha) }),
    getTree: () =>
      down()
        ? failed
        : {
            body: {
              sha: `tree-${repo.sha}`,
              truncated: repo.truncatedTree === true,
              tree: Object.entries(repo.files).map(([path, content]) =>
                treeEntry(path, { sha: blobShaOf(content) }),
              ),
            },
          },
    getContents: (_owner, _name, path) => {
      if (down()) return failed;
      if ((repo.unreadable ?? []).includes(path)) {
        return { status: 404, body: { message: "Not Found" } };
      }
      const content = repo.files[path];
      if (typeof content !== "string") return { status: 404, body: { message: "Not Found" } };
      return {
        body: {
          type: "file",
          encoding: "base64",
          content: Buffer.from(content, "utf8").toString("base64"),
          sha: blobShaOf(content),
        },
      };
    },
  });
  return fixture;
}

describe("workflow collector", () => {
  let db: AppDb;
  /** The team's credential rows, which decide whether a team file's
   * triggers arm (`teamServiceReadiness`). Empty unless a case adds one. */
  let credentials: InMemoryCredentialStore;

  beforeEach(async () => {
    const { appDb } = await freshTestPgDb();
    db = appDb;
    credentials = new InMemoryCredentialStore();
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await db.insert(users).values({ id: "u1", email: "u1@x.test", name: "u1", role: "member" });
    await db.insert(orgMembers).values({ orgId: ORG, userId: "u1", role: "member" });
    await db.insert(teams).values({ id: TEAM, orgId: ORG, name: "Team", createdAt: Date.now() });
    await db.insert(teamMembers).values({ teamId: TEAM, userId: "u1", role: "member" });
  });

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  /** `plugins` supplies the event catalog `validateSubscription` reads. It
   * defaults to none, which fails closed: with no catalog every event key is
   * unknown, and a file declaring events reports that instead of arming a
   * subscription nothing can deliver. */
  function serviceFor(
    f: GithubFixture,
    plugins: ValetPlugin[] = [],
    store: CredentialStore = credentials,
  ): ContentSyncService {
    return new ContentSyncService({
      db,
      reader: new GitHubSkillRepoReader({ apiUrl: f.url }),
      collectors: [new SkillCollector(), new WorkflowCollector({ plugins, credentials: store })],
    });
  }

  /** A team source that collects workflows and nothing else. `kinds` is not
   * accepted on create yet (that is the source-routes task), so this sets the
   * column. Workflows only, so the skills collector's "found no SKILL.md"
   * notice does not colour every outcome in this suite. */
  async function teamSource(repo = "tkhq/automation"): Promise<string> {
    const source = await createContentSource(db, { userId: "u1", orgId: ORG }, { repo, teamId: TEAM });
    await db
      .update(contentSources)
      .set({ kinds: ["workflows"] })
      .where(eq(contentSources.id, source.id));
    return source.id;
  }

  async function mirrored(): Promise<Array<typeof workflowDefinitions.$inferSelect>> {
    return db
      .select()
      .from(workflowDefinitions)
      .orderBy(workflowDefinitions.upstreamPath);
  }

  it.each([false, true])("judges a parent before its changed callee in the same sync (initial ready: %s)", async (initialReady) => {
    const childPath = ".valet/workflows/z-child.yaml";
    const child = (ready: boolean) => JSON.stringify({
      valet: "workflow/v1",
      definition: ready ? GRAPH : {
        version: "dag/v1",
        nodes: [
          { id: "start", type: "trigger" },
          { id: "tool", type: "tool", service: "linear", action: "list_issues", params: {} },
        ],
        edges: [{ from: "start", to: "tool" }],
      },
    });
    const repo: FakeRepo = { sha: "c1", files: { [childPath]: child(initialReady) } };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);
    const childId = (await mirrored())[0].id;
    repo.files[".valet/workflows/a-parent.yaml"] = JSON.stringify({
      valet: "workflow/v1",
      definition: {
        version: "dag/v1",
        nodes: [{ id: "start", type: "trigger" }, { id: "call", type: "workflow", workflowId: childId }],
        edges: [{ from: "start", to: "call" }],
      },
      schedule: { name: "Parent", cron: "0 3 * * *" },
    });
    repo.sha = "c2";
    await serviceFor(f).syncOnce(id);
    expect(await db.select().from(workflowSchedules)).toHaveLength(initialReady ? 1 : 0);
    repo.files[childPath] = child(!initialReady);
    repo.sha = "c3";
    await serviceFor(f).syncOnce(id);
    expect(await db.select().from(workflowSchedules)).toHaveLength(initialReady ? 0 : 1);
  });

  it.each(["removed", "invalid", "unreadable", "bad-trigger", "other-owner"])("does not certify a referenced %s file using its old definition", async (state) => {
    const path = ".valet/workflows/z-child.yaml";
    const repo: FakeRepo = { sha: "c1", files: { [path]: workflowYaml("Child") } };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);
    const childId = (await mirrored())[0].id;
    repo.files[".valet/workflows/a-parent.yaml"] = JSON.stringify({
      valet: "workflow/v1",
      definition: {
        version: "dag/v1",
        nodes: [{ id: "start", type: "trigger" }, { id: "call", type: "workflow", workflowId: childId }],
        edges: [{ from: "start", to: "call" }],
      },
      schedule: { name: "Parent", cron: "0 3 * * *" },
    });
    repo.sha = "c2";
    await serviceFor(f).syncOnce(id);
    const parentId = (await mirrored()).find((row) => row.upstreamPath?.endsWith("a-parent.yaml"))?.id;
    expect(await db.select().from(workflowSchedules)).toHaveLength(1);
    if (state === "removed") delete repo.files[path];
    if (state === "invalid") repo.files[path] = "valet: [";
    if (state === "unreadable") repo.unreadable = [path];
    if (state === "bad-trigger") repo.files[path] += "schedule: { name: bad, cron: nope }\n";
    if (state === "other-owner") {
      await db.update(workflowDefinitions).set({ ownerType: "user", ownerId: "u1" }).where(eq(workflowDefinitions.id, childId));
    }
    // Change a blob so the manifest shortcut cannot skip this collector pass.
    repo.files[".valet/workflows/a-parent.yaml"] += "\n";
    repo.sha = "c3";
    const outcome = await serviceFor(f).syncOnce(id);
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
    expect(outcome?.warnings.join(" ")).toContain("Reference a workflow this team owns");
    const remaining = await mirrored();
    expect(remaining.some((row) => row.id === parentId)).toBe(true);
    expect(remaining.some((row) => row.id === childId)).toBe(state !== "removed");
  });

  it("keeps an unseen callee and its surviving parent's schedule on a partial scan", async () => {
    const childPath = ".valet/workflows/z-child.yaml";
    const parentPath = ".valet/workflows/a-parent.yaml";
    const repo: FakeRepo = { sha: "c1", files: { [childPath]: workflowYaml("Child") } };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);
    const childId = (await mirrored())[0].id;
    const parent = JSON.stringify({
      valet: "workflow/v1",
      definition: {
        version: "dag/v1",
        nodes: [{ id: "start", type: "trigger" }, { id: "call", type: "workflow", workflowId: childId }],
        edges: [{ from: "start", to: "call" }],
      },
      schedule: { name: "Parent", cron: "0 3 * * *" },
    });
    repo.files[parentPath] = parent;
    repo.sha = "c2";
    await serviceFor(f).syncOnce(id);
    const [schedule] = await db.select().from(workflowSchedules);
    expect(schedule).toBeDefined();
    const [source] = await db.select().from(contentSources).where(eq(contentSources.id, id));
    // The workflow rail currently refuses cut trees. Exercise the collector's
    // defensive partial-scan contract directly, without a complete listing.
    const pass = new WorkflowCollector({ plugins: [], credentials }).discover({
      source, entries: [{ path: parentPath, type: "blob", mode: "100644", sha: blobShaOf(parent) }],
    });
    const result = await pass.reconcile({
      db, source, text: new Map([[parentPath, parent]]), discovery: "directory-walk",
      commitSha: "c3", now: Date.now,
    });
    expect(result.deleted).toBe(0);
    expect(result.keptStale).toEqual(["Child"]);
    expect((await mirrored()).some((row) => row.id === childId)).toBe(true);
    expect(await db.select().from(workflowSchedules)).toEqual([schedule]);
  });

  it.each(["team", "user"] as const)("does not overwrite another source's %s-owned callee through a file ID", async (ownerType) => {
    const id = await teamSource();
    const otherSource = await teamSource("tkhq/other-automation");
    const definition = {
      version: "dag/v1",
      nodes: [
        { id: "start", type: "trigger" },
        { id: "tool", type: "tool", service: "linear", action: "list_issues", params: {} },
      ],
      edges: [{ from: "start", to: "tool" }],
    };
    await db.insert(workflowDefinitions).values({
      id: "external-child", orgId: ORG, ownerType, ownerId: ownerType === "team" ? TEAM : "u1",
      name: "External", origin: "repo", sourceId: otherSource,
      upstreamPath: ".valet/workflows/z-child.yaml", definition, createdAt: 1, updatedAt: 1,
    });
    const f = serve({ sha: "c1", files: {
      ".valet/workflows/z-child.yaml": JSON.stringify({ valet: "workflow/v1", id: "external-child", definition: GRAPH }),
      ".valet/workflows/a-parent.yaml": JSON.stringify({
        valet: "workflow/v1",
        definition: {
          version: "dag/v1",
          nodes: [{ id: "start", type: "trigger" }, { id: "call", type: "workflow", workflowId: "external-child" }],
          edges: [{ from: "start", to: "call" }],
        },
        schedule: { name: "Parent", cron: "0 3 * * *" },
      }),
    } });
    const outcome = await serviceFor(f).syncOnce(id);
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
    expect(outcome?.warnings.join(" ")).toContain(ownerType === "team" ? "linear" : "Reference a workflow this team owns");
    const [external] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, "external-child"));
    expect(external).toMatchObject({ sourceId: otherSource, ownerType, definition });
    const ownChild = (await mirrored()).find((row) => row.sourceId === id && row.upstreamPath?.endsWith("z-child.yaml"));
    expect(ownChild?.id).toBeDefined();
    expect(ownChild?.id).not.toBe("external-child");
  });

  it("mirrors a workflow file from each root, owned by the source's team", async () => {
    const f = serve({
      sha: "c1",
      files: {
        ".valet/workflows/nightly.yaml": workflowYaml("Nightly"),
        "workflows/billing/invoice.yml": workflowYaml("Invoice"),
        "README.md": "# repo\n",
      },
    });
    const id = await teamSource();

    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.status).toBe("ok");

    const rows = await mirrored();
    expect(rows.map((r) => r.upstreamPath)).toEqual([
      ".valet/workflows/nightly.yaml",
      "workflows/billing/invoice.yml",
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Nightly", "Invoice"]);
    for (const row of rows) {
      expect(row.origin).toBe("repo");
      expect(row.sourceId).toBe(id);
      expect(row.ownerType).toBe("team");
      expect(row.ownerId).toBe(TEAM);
      expect(row.orgId).toBe(ORG);
    }
    // Version 1 per workflow, stamped with the commit that produced it.
    const versions = await db.select().from(workflowVersions);
    expect(versions).toHaveLength(2);
    expect(versions.every((v) => v.version === 1 && v.sourceCommit === "c1")).toBe(true);
  });

  it("adds a version carrying the new commit when the graph changes", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: { ".valet/workflows/nightly.yaml": workflowYaml("Nightly") },
    };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);

    repo.sha = "c2";
    // A different graph, still valid: the stop node is renamed, which moves
    // the definition hash and so mints a version.
    repo.files[".valet/workflows/nightly.yaml"] = workflowYaml("Nightly", "done");
    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.warnings).toEqual([]);
    expect(outcome?.status).toBe("ok");

    const versions = await db.select().from(workflowVersions).orderBy(workflowVersions.version);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions.map((v) => v.sourceCommit)).toEqual(["c1", "c2"]);
    expect(versions.every((v) => v.origin === "repo")).toBe(true);
  });

  it("removes the definition, its versions, and its triggers when the file goes", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: {
        ".valet/workflows/nightly.yaml": workflowYaml("Nightly"),
        ".valet/workflows/keep.yaml": workflowYaml("Keep"),
      },
    };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);

    const rowsBefore = await mirrored();
    const gone = rowsBefore.find((r) => r.upstreamPath === ".valet/workflows/nightly.yaml");
    expect(gone).toBeDefined();
    if (gone === undefined) throw new Error("unreachable");
    const now = Date.now();
    await db.insert(workflowSchedules).values({
      id: "sched_1",
      orgId: ORG,
      ownerType: "team",
      ownerId: TEAM,
      targetKind: "workflow",
      workflowId: gone.id,
      name: "nightly",
      cron: "0 3 * * *",
      nextFireAt: now + 1000,
      createdBy: "u1",
      createdAt: now,
      updatedAt: now,
    });

    repo.sha = "c2";
    delete repo.files[".valet/workflows/nightly.yaml"];
    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.status).toBe("ok");

    const rows = await mirrored();
    expect(rows.map((r) => r.upstreamPath)).toEqual([".valet/workflows/keep.yaml"]);
    expect(await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, gone.id))).toHaveLength(0);
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
  });

  it("disarms rather than deletes while a run has not settled, and deletes once it has", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: { ".valet/workflows/nightly.yaml": workflowYaml("Nightly") },
    };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);
    const [row] = await mirrored();

    const now = Date.now();
    await db.insert(workflowRuns).values({
      id: "wfrun_1",
      workflowId: row.id,
      definitionVersionId: "v1",
      definition: GRAPH,
      params: {},
      status: "running",
      ownerType: "team",
      ownerId: TEAM,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workflowSchedules).values({
      id: "sched_1",
      orgId: ORG,
      ownerType: "team",
      ownerId: TEAM,
      targetKind: "workflow",
      workflowId: row.id,
      name: "nightly",
      cron: "0 3 * * *",
      nextFireAt: now + 1000,
      createdBy: "u1",
      createdAt: now,
      updatedAt: now,
    });

    repo.sha = "c2";
    repo.files = { "README.md": "# repo\n" };
    await serviceFor(f).syncOnce(id);

    // The definition survives so the run stays reachable; nothing can start it.
    expect(await mirrored()).toHaveLength(1);
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);

    await db.update(workflowRuns).set({ status: "settled" }).where(eq(workflowRuns.id, "wfrun_1"));
    repo.sha = "c3";
    await serviceFor(f).syncOnce(id);
    expect(await mirrored()).toHaveLength(0);
  });

  // The bug this pins: `upstream` was built from the bodies the rail managed
  // to read, so one 404 in the window between the tree read and the file read
  // deleted the workflow, its versions and its triggers, and the next sync
  // re-imported the file under a new id that the old runs did not point at.
  it("keeps the mirror when a listed file cannot be read", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: {
        ".valet/workflows/nightly.yaml": workflowYaml("Nightly"),
        ".valet/workflows/other.yaml": workflowYaml("Other"),
      },
    };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);
    const before = await mirrored();
    expect(before).toHaveLength(2);
    const nightly = before.find((r) => r.upstreamPath === ".valet/workflows/nightly.yaml");
    expect(nightly).toBeDefined();
    if (nightly === undefined) throw new Error("unreachable");

    const now = Date.now();
    await db.insert(workflowSchedules).values({
      id: "sched_1",
      orgId: ORG,
      ownerType: "team",
      ownerId: TEAM,
      targetKind: "workflow",
      workflowId: nightly.id,
      name: "nightly",
      cron: "0 3 * * *",
      nextFireAt: now + 1000,
      createdBy: "u1",
      createdAt: now,
      updatedAt: now,
    });

    // A commit that changes the OTHER file, so compare 2 does not stop the
    // poll, while nightly.yaml is listed and unreadable.
    repo.sha = "c2";
    repo.files[".valet/workflows/other.yaml"] = workflowYaml("Other", "done");
    repo.unreadable = [".valet/workflows/nightly.yaml"];
    const outcome = await serviceFor(f).syncOnce(id);

    const after = await mirrored();
    expect(after.map((r) => r.upstreamPath)).toEqual([
      ".valet/workflows/nightly.yaml",
      ".valet/workflows/other.yaml",
    ]);
    // Same row, so its runs and its version history still point at it.
    expect(after.find((r) => r.upstreamPath === ".valet/workflows/nightly.yaml")?.id).toBe(
      nightly.id,
    );
    expect(await db.select().from(workflowSchedules)).toHaveLength(1);
    // The rail says so rather than staying quiet, and the commit is not
    // recorded, so the next poll reads the file again.
    expect(outcome?.warnings.join(" ")).toContain(".valet/workflows/nightly.yaml");
    const [row] = await db.select().from(contentSources).where(eq(contentSources.id, id));
    expect(row.lastSha).toBe("c1");
  });

  it("fails one file and mirrors the rest when a definition refers to itself", async () => {
    // A YAML anchor that contains itself. The validator walks nodes and edges
    // and never stringifies the whole value, so it passes; storing it would
    // throw out of the jsonb encoder and take the whole pass with it.
    const cyclic = [
      "valet: workflow/v1",
      "name: Loop",
      "definition: &def",
      "  version: dag/v1",
      "  self: *def",
      "  nodes:",
      "    - id: trigger",
      "      type: trigger",
      "    - id: stop",
      "      type: stop",
      "  edges:",
      "    - from: trigger",
      "      to: stop",
      "",
    ].join("\n");
    const f = serve({
      sha: "c1",
      files: {
        ".valet/workflows/loop.yaml": cyclic,
        ".valet/workflows/fine.yaml": workflowYaml("Fine"),
      },
    });
    const id = await teamSource();
    const outcome = await serviceFor(f).syncOnce(id);

    expect(outcome?.status).toBe("warning");
    const rows = await mirrored();
    expect(rows.map((r) => r.upstreamPath)).toEqual([".valet/workflows/fine.yaml"]);
    expect(outcome?.warnings.join(" ")).toContain(".valet/workflows/loop.yaml");
  });

  it("names the file in a validation warning", async () => {
    const f = serve({
      sha: "c1",
      files: {
        ".valet/workflows/broken.yaml": [
          "valet: workflow/v1",
          "name: Broken",
          "definition:",
          "  version: dag/v1",
          "  nodes:",
          "    - id: trigger",
          "      type: trigger",
          "  edges:",
          "    - from: trigger",
          "      to: nowhere",
          "",
        ].join("\n"),
      },
    });
    const id = await teamSource();
    const outcome = await serviceFor(f).syncOnce(id);
    // The validator names the node. Without the path in front, the source
    // status says a node is wrong and never says which file holds it.
    expect(outcome?.warnings.join(" ")).toContain(".valet/workflows/broken.yaml");
  });

  it("mints no version when only the file's name key changed", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: { ".valet/workflows/nightly.yaml": workflowYaml("Nightly") },
    };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);

    repo.sha = "c2";
    repo.files[".valet/workflows/nightly.yaml"] = workflowYaml("Renamed");
    await serviceFor(f).syncOnce(id);

    const rows = await mirrored();
    expect(rows[0].name).toBe("Renamed");
    // Same graph, so one version, matching the product edit path where a
    // rename alone mints nothing.
    expect(await db.select().from(workflowVersions)).toHaveLength(1);
  });

  it("reconciles nothing when the read fails", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: { ".valet/workflows/nightly.yaml": workflowYaml("Nightly") },
    };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);
    expect(await mirrored()).toHaveLength(1);

    repo.sha = "c2";
    repo.files = {};
    repo.failAfter = f.calls.length;
    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.status).toBe("error");
    expect(await mirrored()).toHaveLength(1);
  });

  // A cut tree must never reconcile. The workflow collector claims paths from
  // the repository ROOT and has no `walkDirectory`, so with a subpath set it
  // contributes no pass at all and there is nothing to prove; the case that
  // matters is a cut tree with no subpath, where the rail fails the whole sync
  // rather than reading a partial listing as a delete list.
  it("fails the sync rather than deleting when GitHub cuts the tree", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: {
        ".valet/workflows/nightly.yaml": workflowYaml("Nightly"),
        ".valet/workflows/other.yaml": workflowYaml("Other"),
      },
    };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);
    expect(await mirrored()).toHaveLength(2);

    // The same commit, now over a cut tree: every file past the cut would
    // read as deleted if the rail reconciled it.
    repo.sha = "c2";
    repo.files = {};
    repo.truncatedTree = true;
    const outcome = await serviceFor(f).syncOnce(id);

    expect(outcome?.status).toBe("error");
    expect(await mirrored()).toHaveLength(2);
    const [row] = await db.select().from(contentSources).where(eq(contentSources.id, id));
    expect(row.lastSha).toBe("c1");
  });

  it("keeps the mirrored row when the file stops parsing, and says why", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: { ".valet/workflows/nightly.yaml": workflowYaml("Nightly") },
    };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);

    repo.sha = "c2";
    repo.files[".valet/workflows/nightly.yaml"] = "valet: workflow/v1\nname: [unclosed\n";
    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.status).toBe("warning");

    const rows = await mirrored();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Nightly");
    expect(outcome?.warnings.join(" ")).toContain(".valet/workflows/nightly.yaml");
  });

  it("ignores an unlabeled file under workflows/ and reports one under .valet/workflows/", async () => {
    const f = serve({
      sha: "c1",
      files: {
        "workflows/ci.yml": "name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu\n",
        ".valet/workflows/oops.yaml": "name: forgot the label\nsteps: []\n",
      },
    });
    const id = await teamSource();
    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.status).toBe("warning");
    expect(await mirrored()).toHaveLength(0);

    const said = (outcome?.warnings ?? []).join(" ");
    expect(said).toContain(".valet/workflows/oops.yaml");
    expect(said).not.toContain("workflows/ci.yml");
  });

  it("mirrors nothing from a user source and says where workflows do sync", async () => {
    const f = serve({
      sha: "c1",
      files: { ".valet/workflows/nightly.yaml": workflowYaml("Nightly") },
    });
    const source = await createContentSource(db, { userId: "u1", orgId: ORG }, { repo: "tkhq/mine" });
    await db.update(contentSources).set({ kinds: ["workflows"] }).where(eq(contentSources.id, source.id));

    const outcome = await serviceFor(f).syncOnce(source.id);
    expect(outcome?.status).toBe("warning");
    expect(await mirrored()).toHaveLength(0);
    expect(outcome?.notice).toContain("team source");
  });

  describe("triggers a file declares", () => {
    const scheduled = (cron: string) =>
      [
        "valet: workflow/v1",
        "name: Nightly",
        "schedule:",
        `  cron: "${cron}"`,
        "  name: Nightly run",
        "  timezone: UTC",
        "definition:",
        "  version: dag/v1",
        "  nodes:",
        "    - id: trigger",
        "      type: trigger",
        "    - id: stop",
        "      type: stop",
        "  edges:",
        "    - from: trigger",
        "      to: stop",
        "",
      ].join("\n");

    it("mirrors disconnected Linear workflows without arming events and preserves their schedule", async () => {
      const path = ".valet/workflows/linear.yaml";
      const repo: FakeRepo = { sha: "c1", files: { [path]: scheduled("0 3 * * *") + "\nevents:\n  - eventKeys: [linear.issue.update]\n" } };
      const f = serve(repo);
      const id = await teamSource();
      const outcome = await serviceFor(f,[linearEventPlugin]).syncOnce(id);
      expect(outcome?.warnings.join(" ")).toContain("Linear event triggers remain off");
      expect(await mirrored()).toHaveLength(1);
      expect(await db.select().from(workflowSchedules)).toHaveLength(1);
      expect(await db.select().from(eventSubscriptions)).toHaveLength(0);
      await db.insert(linearInstallations).values({ id: "repo-install", orgId: ORG, workspaceId: "linear-org", workspaceName: "Linear", webhookId: "webhook", connectedBy: "u1", createdAt: 1, updatedAt: 1 });
      await credentials.save({ type: "org", id: ORG },"linear",{ type: "oauth2", accessToken: "token", metadata: { webhookSecret: "secret" } });
      // Connecting ingress must arm the same repository commit on the next sync.
      await serviceFor(f,[linearEventPlugin]).syncOnce(id);
      expect(await db.select().from(eventSubscriptions)).toHaveLength(1);
    });

    it("arms a schedule, rewrites it when the cron moves, and disarms it when the block goes", async () => {
      const repo: FakeRepo = {
        sha: "c1",
        files: { ".valet/workflows/nightly.yaml": scheduled("0 3 * * *") },
      };
      const f = serve(repo);
      const id = await teamSource();
      await serviceFor(f).syncOnce(id);

      const armed = await db.select().from(workflowSchedules);
      expect(armed).toHaveLength(1);
      expect(armed[0].cron).toBe("0 3 * * *");
      expect(armed[0].origin).toBe("repo");
      expect(armed[0].ownerType).toBe("team");
      expect(armed[0].workflowId).toBe((await mirrored())[0].id);
      const scheduleId = armed[0].id;

      repo.sha = "c2";
      repo.files[".valet/workflows/nightly.yaml"] = scheduled("0 5 * * *");
      await serviceFor(f).syncOnce(id);
      const moved = await db.select().from(workflowSchedules);
      expect(moved).toHaveLength(1);
      // The same row, so its id stays stable for anything holding it.
      expect(moved[0].id).toBe(scheduleId);
      expect(moved[0].cron).toBe("0 5 * * *");

      // Removing the block disarms it, which is why this reconciles rather
      // than only inserting.
      repo.sha = "c3";
      repo.files[".valet/workflows/nightly.yaml"] = workflowYaml("Nightly");
      await serviceFor(f).syncOnce(id);
      expect(await db.select().from(workflowSchedules)).toHaveLength(0);
    });

    it("fails the file on a bad cron and mirrors nothing from it", async () => {
      const f = serve({
        sha: "c1",
        files: {
          ".valet/workflows/bad.yaml": scheduled("not a cron"),
          ".valet/workflows/fine.yaml": workflowYaml("Fine"),
        },
      });
      const id = await teamSource();
      const outcome = await serviceFor(f).syncOnce(id);

      // The other file still mirrors: one file's mistake costs that file.
      expect((await mirrored()).map((r) => r.upstreamPath)).toEqual([
        ".valet/workflows/fine.yaml",
      ]);
      expect(await db.select().from(workflowSchedules)).toHaveLength(0);
      expect(outcome?.warnings.join(" ")).toContain(".valet/workflows/bad.yaml");
    });

    it("leaves a schedule a person armed alone", async () => {
      const repo: FakeRepo = {
        sha: "c1",
        files: { ".valet/workflows/nightly.yaml": scheduled("0 3 * * *") },
      };
      const f = serve(repo);
      const id = await teamSource();
      await serviceFor(f).syncOnce(id);
      const workflowId = (await mirrored())[0].id;

      // Decision 8 keeps the Triggers page open on a mirrored workflow, so a
      // person's row has to survive a resync that rewrites the file's own.
      const now = Date.now();
      await db.insert(workflowSchedules).values({
        id: "sched_by_hand",
        orgId: ORG,
        ownerType: "team",
        ownerId: TEAM,
        targetKind: "workflow",
        workflowId,
        name: "by hand",
        cron: "30 9 * * 1",
        origin: "local",
        nextFireAt: now + 1000,
        createdBy: "u1",
        createdAt: now,
        updatedAt: now,
      });

      repo.sha = "c2";
      repo.files[".valet/workflows/nightly.yaml"] = workflowYaml("Nightly");
      await serviceFor(f).syncOnce(id);

      const left = await db.select().from(workflowSchedules);
      expect(left.map((r) => r.id)).toEqual(["sched_by_hand"]);
    });

    // The events half had no test at all, so the whole subscription path was
    // unexercised: validation, arming, reconcile, and the org owner rule.
    const withEvents = (filters: string) =>
      [
        "valet: workflow/v1",
        "name: On push",
        "events:",
        "  - eventKeys:",
        "      - github.push",
        "    name: On a push",
        filters,
        "definition:",
        "  version: dag/v1",
        "  nodes:",
        "    - id: trigger",
        "      type: trigger",
        "    - id: stop",
        "      type: stop",
        "  edges:",
        "    - from: trigger",
        "      to: stop",
        "",
      ]
        .filter((line) => line !== "")
        .join("\n");

    it("arms an event subscription, updates its filters, and disarms it", async () => {
      const repo: FakeRepo = {
        sha: "c1",
        files: {
          ".valet/workflows/onpush.yaml": withEvents(
            "    filters:\n      - field: repo\n        op: eq\n        value: acme/service",
          ),
        },
      };
      const f = serve(repo);
      const id = await teamSource();
      await serviceFor(f, [githubPlugin]).syncOnce(id);

      const armed = await db.select().from(eventSubscriptions);
      expect(armed).toHaveLength(1);
      expect(armed[0].origin).toBe("repo");
      expect(armed[0].eventKeys).toEqual(["github.push"]);
      expect(armed[0].target).toMatchObject({ kind: "workflow" });
      const subId = armed[0].id;

      repo.sha = "c2";
      repo.files[".valet/workflows/onpush.yaml"] = withEvents(
        "    filters:\n      - field: repo\n        op: eq\n        value: acme/other",
      );
      await serviceFor(f, [githubPlugin]).syncOnce(id);
      const moved = await db.select().from(eventSubscriptions);
      expect(moved).toHaveLength(1);
      expect(moved[0].id).toBe(subId);
      expect(moved[0].filters).toMatchObject([{ value: "acme/other" }]);

      repo.sha = "c3";
      repo.files[".valet/workflows/onpush.yaml"] = workflowYaml("On push");
      await serviceFor(f, [githubPlugin]).syncOnce(id);
      expect(await db.select().from(eventSubscriptions)).toHaveLength(0);
    });

    // With no event catalog every key is unknown, so a file declaring events
    // reports that rather than arming a subscription nothing can deliver.
    it("fails the file when this deployment has no catalog for its event key", async () => {
      const f = serve({
        sha: "c1",
        files: { ".valet/workflows/onpush.yaml": withEvents("") },
      });
      const id = await teamSource();
      const outcome = await serviceFor(f).syncOnce(id);

      expect(await mirrored()).toHaveLength(0);
      expect(await db.select().from(eventSubscriptions)).toHaveLength(0);
      expect(outcome?.warnings.join(" ")).toContain(".valet/workflows/onpush.yaml");
    });

    it("fails the file when a filter names a field the catalog does not declare", async () => {
      const f = serve({
        sha: "c1",
        files: {
          ".valet/workflows/bad.yaml": withEvents(
            "    filters:\n      - field: not_a_field\n        op: eq\n        value: x",
          ),
          ".valet/workflows/fine.yaml": workflowYaml("Fine"),
        },
      });
      const id = await teamSource();
      const outcome = await serviceFor(f, [githubPlugin]).syncOnce(id);

      expect((await mirrored()).map((r) => r.upstreamPath)).toEqual([
        ".valet/workflows/fine.yaml",
      ]);
      expect(await db.select().from(eventSubscriptions)).toHaveLength(0);
      expect(outcome?.warnings.join(" ")).toContain(".valet/workflows/bad.yaml");
    });

    // `next_fire_at` must hold still on a name-only edit, or every poll pushes
    // a due schedule further out and it never fires.
    it("holds next_fire_at still when only the schedule name changed", async () => {
      const named = (name: string) =>
        [
          "valet: workflow/v1",
          "name: Nightly",
          "schedule:",
          '  cron: "0 3 * * *"',
          `  name: ${name}`,
          "definition:",
          "  version: dag/v1",
          "  nodes:",
          "    - id: trigger",
          "      type: trigger",
          "    - id: stop",
          "      type: stop",
          "  edges:",
          "    - from: trigger",
          "      to: stop",
          "",
        ].join("\n");
      const repo: FakeRepo = { sha: "c1", files: { ".valet/workflows/n.yaml": named("First") } };
      const f = serve(repo);
      const id = await teamSource();
      await serviceFor(f).syncOnce(id);
      const [before] = await db.select().from(workflowSchedules);

      repo.sha = "c2";
      repo.files[".valet/workflows/n.yaml"] = named("Renamed");
      await serviceFor(f).syncOnce(id);
      const [after] = await db.select().from(workflowSchedules);

      expect(after.name).toBe("Renamed");
      expect(after.nextFireAt).toBe(before.nextFireAt);
    });

    /** A scheduled team file with one tool node on `service`. `body` wraps
     * the node in a foreach when set. */
    function nightlyReport(body: "top-level" | "foreach" = "top-level", service = "github"): string {
      const tool = [
        "      type: tool",
        `      service: ${service}`,
        "      action: list_issues",
        "      params: {}",
      ];
      const node =
        body === "top-level"
          ? ["    - id: fetch", ...tool]
          : [
              "    - id: fetch",
              "      type: foreach",
              '      items: "{{ trigger.data.repos }}"',
              "      body:",
              "        id: one",
              ...tool.map((line) => `  ${line}`),
            ];
      return [
        "valet: workflow/v1",
        "name: Nightly report",
        "schedule:",
        '  cron: "0 3 * * *"',
        "  name: Nightly report",
        "definition:",
        "  version: dag/v1",
        "  nodes:",
        "    - id: trigger",
        "      type: trigger",
        ...node,
        "    - id: stop",
        "      type: stop",
        "  edges:",
        "    - from: trigger",
        "      to: fetch",
        "    - from: fetch",
        "      to: stop",
        "",
      ].join("\n");
    }

    it("disarms and restores delegated schedules after membership changes at the same commit", async () => {
      await credentials.save({ type: "user", id: "u1" }, "github", { type: "oauth2", accessToken: "personal-token" });
      await credentials.save({ type: "team", id: TEAM }, "github", { type: "oauth2", metadata: { delegatedFrom: "u1" } });
      const f = serve({ sha: "c1", files: { ".valet/workflows/report.yaml": nightlyReport() } });
      const id = await teamSource();
      await serviceFor(f).syncOnce(id);
      expect(await db.select().from(workflowSchedules)).toHaveLength(1);
      await removeMember(db, { teamId: TEAM, userId: "u1" });
      await serviceFor(f).pollOnce();
      expect(await db.select().from(workflowSchedules)).toHaveLength(0);
      await addMember(db, { teamId: TEAM, userId: "u1", role: "member" });
      await serviceFor(f).pollOnce();
      expect(await db.select().from(workflowSchedules)).toHaveLength(1);
      expect(await mirrored()).toHaveLength(1);
    });

    function barrier() {
      let release = () => {};
      const promise = new Promise<void>((resolve) => { release = resolve; });
      return { promise, release };
    }

    it.each([false, true])("preserves readiness invalidation across an older writer (newer finishes first: %s)", async (newerFirst) => {
      await credentials.save({ type: "team", id: TEAM }, "github", { type: "oauth2", accessToken: "team-token" });
      const f = serve({ sha: "c1", files: { ".valet/workflows/report.yaml": nightlyReport().replace("definition:", "events:\n  - eventKeys: [github.push]\ndefinition:") } });
      const id = await teamSource();
      const service = serviceFor(f, [githubPlugin]);
      await service.stop();
      await service.syncOnce(id);
      expect(await db.select().from(workflowSchedules)).toHaveLength(1);
      expect(await db.select().from(eventSubscriptions)).toHaveLength(1);
      await service.resyncTeamWorkflowSources(TEAM);

      const prepared = barrier();
      const resume = barrier();
      const collector = new WorkflowCollector({ plugins: [githubPlugin], credentials });
      const discover = collector.discover.bind(collector);
      collector.discover = (ctx) => {
        const pass = discover(ctx);
        const prepare = pass.prepareReconcile;
        pass.prepareReconcile = async (ctx) => {
          if (!prepare) throw new Error("Workflow collector must prepare readiness before writes");
          const write = await prepare.call(pass, ctx);
          prepared.release();
          await resume.promise;
          return write;
        };
        return pass;
      };
      const older = new ContentSyncService({ db, reader: new GitHubSkillRepoReader({ apiUrl: f.url }), collectors: [collector] });
      const pending = older.syncOnce(id);
      await prepared.promise;
      await credentials.delete({ type: "team", id: TEAM }, "github");
      await service.resyncTeamWorkflowSources(TEAM);
      // A new service reads the durable request without any process-local state.
      const newer = serviceFor(f, [githubPlugin]);
      try {
        if (newerFirst) await newer.pollOnce();
      } finally {
        resume.release();
      }
      expect((await pending)?.notice).toContain("superseded");
      if (!newerFirst) {
        const [dirty] = await db.select().from(contentSources).where(eq(contentSources.id, id));
        expect(dirty.discoveryScan).toBeNull();
        expect(dirty.lastManifestHash).toBeNull();
        expect(dirty.nextAttemptAt).toBeLessThanOrEqual(Date.now());
        await newer.pollOnce();
      }
      expect(await db.select().from(workflowSchedules)).toHaveLength(0);
      expect(await db.select().from(eventSubscriptions)).toHaveLength(0);
      expect(await mirrored()).toHaveLength(1);
      const [done] = await db.select().from(contentSources).where(eq(contentSources.id, id));
      expect(done.lastSha).toBe("c1");
      expect(done.discoveryScan).not.toBeNull();
      expect(done.lastError).toContain("Settings → Organization → GitHub");
    });

    it.each([false, true])("does not consume an invalidation while an old head read settles (failure: %s)", async (failure) => {
      const f = serve({ sha: "c1", files: { ".valet/workflows/report.yaml": nightlyReport() } });
      const id = await teamSource();
      const service = serviceFor(f);
      await service.stop();
      await service.syncOnce(id);
      const reached = barrier();
      const resume = barrier();
      const reader = new GitHubSkillRepoReader({ apiUrl: f.url });
      const head = reader.head.bind(reader);
      reader.head = async (...args) => {
        const result = await head(...args);
        reached.release();
        await resume.promise;
        if (failure) throw new Error("old transport failure");
        return result;
      };
      const older = new ContentSyncService({ db, reader, collectors: [new WorkflowCollector({ plugins: [], credentials })] });
      const pending = older.syncOnce(id);
      await reached.promise;
      await credentials.save({ type: "team", id: TEAM }, "github", { type: "oauth2", accessToken: "new-token" });
      await service.resyncTeamWorkflowSources(TEAM);
      resume.release();
      await pending;
      const [dirty] = await db.select().from(contentSources).where(eq(contentSources.id, id));
      expect(dirty.discoveryScan).toBeNull();
      expect(dirty.lastManifestHash).toBeNull();
      expect(dirty.nextAttemptAt).toBeLessThanOrEqual(Date.now());
      expect(dirty.status).not.toBe("error");
      await serviceFor(f).pollOnce();
      expect(await db.select().from(workflowSchedules)).toHaveLength(1);
    });

    it("rolls back collector writes when a later write fails", async () => {
      await credentials.save({ type: "team", id: TEAM }, "github", { type: "oauth2", accessToken: "team-token" });
      const f = serve({ sha: "c1", files: { ".valet/workflows/report.yaml": nightlyReport() } });
      const id = await teamSource();
      const collector = new WorkflowCollector({ plugins: [], credentials });
      const discover = collector.discover.bind(collector);
      collector.discover = (ctx) => {
        const pass = discover(ctx);
        const prepare = pass.prepareReconcile;
        pass.prepareReconcile = async (ctx) => {
          if (!prepare) throw new Error("Missing readiness preparation");
          const write = await prepare.call(pass, ctx);
          return async (db) => {
            await write(db);
            throw new Error("write failed after triggers were inserted");
          };
        };
        return pass;
      };
      const service = new ContentSyncService({ db, reader: new GitHubSkillRepoReader({ apiUrl: f.url }), collectors: [collector] });
      expect((await service.syncOnce(id))?.status).toBe("error");
      expect(await mirrored()).toHaveLength(0);
      expect(await db.select().from(workflowSchedules)).toHaveLength(0);
      expect(await db.select().from(workflowVersions)).toHaveLength(0);
      await serviceFor(f).syncOnce(id);
      expect(await db.select().from(workflowSchedules)).toHaveLength(1);
    });

    it("arms a team file with tool nodes when the team can act as each service", async () => {
      await credentials.save({ type: "team", id: TEAM }, "github", {
        type: "oauth2",
        accessToken: "ghu_team",
      });
      const f = serve({ sha: "c1", files: { ".valet/workflows/report.yaml": nightlyReport() } });
      const id = await teamSource();
      const outcome = await serviceFor(f).syncOnce(id);

      expect(await mirrored()).toHaveLength(1);
      expect(await db.select().from(workflowSchedules)).toHaveLength(1);
      expect(outcome?.warnings).toEqual([]);
    });

    it("arms nothing for a team file whose service the team cannot act as, and names it", async () => {
      const f = serve({ sha: "c1", files: { ".valet/workflows/report.yaml": nightlyReport() } });
      const id = await teamSource();
      const outcome = await serviceFor(f).syncOnce(id);

      // Mirrored, and unarmed: decision 15's readiness predicate said no.
      expect(await mirrored()).toHaveLength(1);
      expect(await db.select().from(workflowSchedules)).toHaveLength(0);
      const warning = outcome?.warnings.join(" ") ?? "";
      expect(warning).toContain("report.yaml");
      // The sync has no template to install: the readiness reason is
      // caller-neutral and the collector names its own next step.
      expect(warning).toContain("An admin can set up or refresh the organization GitHub App in Settings → Organization → GitHub");
      expect(warning).toContain("Valet arms it after you connect the service.");
      expect(warning).not.toContain("install this template");
      expect(warning).not.toContain("move the repository");
    });

    // Connecting the service is the fix the warning names, and no commit
    // lands when a team does it. Without a resync the next poll stops at
    // the recorded head and the file stays unarmed until an unrelated push.
    it("arms a mirrored team file once the team connects the service, at the same commit", async () => {
      const f = serve({ sha: "c1", files: { ".valet/workflows/report.yaml": nightlyReport() } });
      const id = await teamSource();
      const service = serviceFor(f);

      const first = await service.syncOnce(id);
      expect(await db.select().from(workflowSchedules)).toHaveLength(0);
      expect(first?.warnings.join(" ")).toContain("Valet arms it after you connect the service.");

      await credentials.save({ type: "team", id: TEAM }, "github", {
        type: "oauth2",
        accessToken: "ghu_team",
      });
      // The repository did not move, so a plain poll learns nothing.
      expect((await service.syncOnce(id))?.changed).toBe(false);
      expect(await db.select().from(workflowSchedules)).toHaveLength(0);

      // The method nudges the sweep; this test drives the pass itself.
      await service.stop();
      expect(await service.resyncTeamWorkflowSources(TEAM)).toBe(1);
      const armed = await service.syncOnce(id);

      expect(armed?.warnings).toEqual([]);
      expect(await db.select().from(workflowSchedules)).toHaveLength(1);
      expect(await mirrored()).toHaveLength(1);
    });

    // A transient fault in the credential store is one file's problem. The
    // pass keeps going, the file is left as it was, and the sync stays
    // incomplete so the next poll checks it again without a commit.
    it("warns and defers one file when its readiness check fails, and mirrors the rest", async () => {
      await credentials.save({ type: "team", id: TEAM }, "github", { type: "oauth2", accessToken: "ghu" });
      await credentials.save({ type: "team", id: TEAM }, "slack", { type: "bot_token", accessToken: "xoxb" });
      const failing: CredentialStore = {
        get: (owner, service) => {
          if (owner.type === "team" && service === "github") {
            throw new Error("credential store unavailable");
          }
          return credentials.get(owner, service);
        },
        save: (owner, service, credential) => credentials.save(owner, service, credential),
        delete: (owner, service) => credentials.delete(owner, service),
        list: (owner) => credentials.list(owner),
      };
      const f = serve({
        sha: "c1",
        files: {
          ".valet/workflows/report.yaml": nightlyReport(),
          ".valet/workflows/digest.yaml": nightlyReport("top-level", "slack"),
        },
      });
      const id = await teamSource();
      const outcome = await serviceFor(f, [], failing).syncOnce(id);

      const rows = await mirrored();
      expect(rows.map((row) => row.upstreamPath)).toEqual([".valet/workflows/digest.yaml"]);
      expect(await db.select().from(workflowSchedules)).toHaveLength(1);
      expect(outcome?.status).toBe("warning");
      const warning = outcome?.warnings.join(" ") ?? "";
      expect(warning).toContain("report.yaml");
      expect(warning).toContain("credential store unavailable");
      expect(warning).not.toContain("digest.yaml");
      // Incomplete, so the next poll re-reads at the same commit.
      const [source] = await db.select().from(contentSources).where(eq(contentSources.id, id));
      expect(source.lastSha).toBeNull();
    });

    it("treats a tool node inside a foreach body like a top-level one", async () => {
      const f = serve({ sha: "c1", files: { ".valet/workflows/report.yaml": nightlyReport("foreach") } });
      const id = await teamSource();
      const outcome = await serviceFor(f).syncOnce(id);

      expect(await mirrored()).toHaveLength(1);
      expect(await db.select().from(workflowSchedules)).toHaveLength(0);
      expect(outcome?.warnings.join(" ")).toContain("Settings → Organization → GitHub");
    });
  });

  // Adding a kind to an existing source changes its candidate set without
  // changing the repository, so compare 1 has to notice. It does because the
  // stored scan mark carries the kinds.
  it("re-scans a source that gains the workflows kind at an unmoved commit", async () => {
    const f = serve({
      sha: "c1",
      files: {
        ".valet/workflows/nightly.yaml": workflowYaml("Nightly"),
        ".valet/skills/thing/SKILL.md": "---\nname: thing\ndescription: A thing.\n---\n\nDo it.\n",
      },
    });
    const source = await createContentSource(
      db,
      { userId: "u1", orgId: ORG },
      { repo: "tkhq/automation", teamId: TEAM },
    );
    // Skills only at first: the workflow file is in the tree and unclaimed.
    await serviceFor(f).syncOnce(source.id);
    expect(await mirrored()).toHaveLength(0);

    // The repository does not move. Only what this source collects does.
    await db
      .update(contentSources)
      .set({ kinds: ["skills", "workflows"] })
      .where(eq(contentSources.id, source.id));
    await serviceFor(f).syncOnce(source.id);

    expect((await mirrored()).map((r) => r.upstreamPath)).toEqual([
      ".valet/workflows/nightly.yaml",
    ]);
  });

  // `last_manifest_hash` means "the file set these mirrored rows came from".
  // An incomplete pass did not mirror that set, so keeping the old value lets
  // a repository that returns to it short-circuit compare 2 forever and the
  // rows the incomplete pass never wrote stay missing.
  it("clears the manifest hash on an incomplete sync, so a revert still reconciles", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: {
        ".valet/workflows/a.yaml": workflowYaml("A"),
        ".valet/workflows/b.yaml": workflowYaml("B"),
      },
    };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);
    expect(await mirrored()).toHaveLength(2);

    // A commit that drops one file AND cannot read the other. The pass is
    // incomplete, so nothing about this commit is recorded.
    repo.sha = "c2";
    delete repo.files[".valet/workflows/b.yaml"];
    repo.unreadable = [".valet/workflows/a.yaml"];
    await serviceFor(f).syncOnce(id);
    const [afterIncomplete] = await db
      .select()
      .from(contentSources)
      .where(eq(contentSources.id, id));
    expect(afterIncomplete.lastSha).toBe("c1");
    expect(afterIncomplete.lastManifestHash).toBeNull();

    // The repository returns to the first commit's file set. With the old
    // hash still stored, compare 2 would stop here and `b` would never come
    // back.
    repo.sha = "c3";
    repo.unreadable = [];
    repo.files[".valet/workflows/b.yaml"] = workflowYaml("B");
    await serviceFor(f).syncOnce(id);
    expect((await mirrored()).map((r) => r.name)).toEqual(["A", "B"]);
  });

  it("never touches a local workflow, including one of the same name", async () => {
    const f = serve({
      sha: "c1",
      files: { ".valet/workflows/nightly.yaml": workflowYaml("Nightly") },
    });
    const id = await teamSource();
    const now = Date.now();
    await db.insert(workflowDefinitions).values({
      id: "wf_local",
      orgId: ORG,
      ownerType: "user",
      ownerId: "u1",
      name: "Nightly",
      definition: GRAPH,
      origin: "local",
      createdAt: now,
      updatedAt: now,
    });

    await serviceFor(f).syncOnce(id);
    const local = await db
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.id, "wf_local"), eq(workflowDefinitions.origin, "local")));
    expect(local).toHaveLength(1);
    expect(await mirrored()).toHaveLength(2);
  });
});
