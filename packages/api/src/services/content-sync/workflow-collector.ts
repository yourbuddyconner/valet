import { linearEventArmBlock } from "../linear-ingress.js";
/**
 * Workflow definitions mirrored from a repository, on the rail
 * `content-sync/collector.ts` defines. Read that file first: it states the
 * rules every collector holds to. Design:
 * `docs/specs/2026-08-24-workflows-mvp-design.md`, decisions 4 to 9.
 *
 * Two roots hold definitions: `.valet/workflows/**`, the folder that holds
 * Valet automation, and a top-level `workflows/**` for a repository whose
 * authors want no dot folder. Nested directories are allowed under either,
 * because a large repository wants
 * `.valet/workflows/billing/monthly-invoice.yaml`.
 *
 * Identity is `(source_id, upstream_path)` and nothing else. Not the name,
 * and not any id the file writes. Renaming a file therefore deletes one
 * workflow and creates another, which is the honest reading of a rename in a
 * system with no rename event: the run history of the old path stays where it
 * is.
 *
 * There is no `walkDirectory`. A commit whose tree GitHub cut mirrors no
 * workflow, and the sweep reports `directory-walk`, which already forbids
 * every delete. A one-level fallback would miss every nested definition and
 * then read the rest as deleted.
 *
 * A source's `subpath` does not narrow this collector, which is the one place
 * it parts from `skill-collector.ts`. The subpath says where a repository
 * keeps its SKILLS; `.valet/` is repository-level configuration and is read
 * from the root whatever that setting holds. A source that sets a subpath and
 * expects it to hide `.valet/workflows` would be surprised, so say it here.
 */
import type { WorkflowDefinition } from "@valet/workflow";
import { and, eq, inArray } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import {
  parseWorkflowFileValue,
  WORKFLOW_FILE_EXTENSIONS,
  type ValidateEnvironment,
  type WorkflowFile,
} from "@valet/workflow";
import type { CredentialStore, ValetPlugin } from "@valet/engine";
import type { AppDb } from "../../lib/drizzle.js";
import { canonicalJson } from "../../lib/canonical-json.js";
import {
  eventSubscriptions,
  workflowDefinitions,
  workflowRuns,
  workflowSchedules,
  workflowVersions,
  type ContentSourceRow,
} from "../../schema/index.js";
import {
  disarmWorkflowTriggers,
  hasUnsettledWorkflowRun,
  newWorkflowId,
  purgeWorkflowRows,
} from "../../workflows/service.js";
import { nextFireAt } from "../../workflows/schedule-service.js";
import {
  teamArmRefusals,
  teamServiceReadiness,
  type TeamServiceReadinessDeps,
} from "../../workflows/team-service-readiness.js";
import type { OnePasswordService } from "../onepassword.js";
import { toolNodesOf, workflowCallsOf } from "../../workflows/tool-nodes.js";
import { validateSubscriptionWrite } from "../../events/subscription-write.js";
import type { SubscriptionFilter } from "../../events/match.js";
import type { SkillTreeEntry } from "../skill-repo-reader.js";
import type {
  CollectorDiscoverContext,
  CollectorNoticeContext,
  CollectorPass,
  CollectorReconcileContext,
  CollectorReconcileResult,
  ContentCollector,
  ContentManifestEntry,
} from "./collector.js";

/** The two roots that hold definitions. */
const WORKFLOW_ROOTS = [".valet/workflows", "workflows"] as const;

export interface WorkflowCollectorDeps {
  /**
   * The dag validator's environment. With it, a file that names an unknown
   * model or an unknown tool service fails at sync with the validator's own
   * message, instead of at run time inside a node. Optional, so a test that
   * mirrors a plain graph needs no plugin catalog.
   */
  env?: ValidateEnvironment;
  /**
   * The plugin registry. `validateSubscription` reads its event catalog to
   * check an `events` block's keys and filter fields, and
   * `teamServiceReadiness` reads its credential declarations and the org's
   * provided services. Required: an empty registry disarms every team
   * file's triggers, because no service is free and none is org-provided.
   * A test that wants that fail-closed answer passes `[]`.
   */
  plugins: ValetPlugin[];
  /**
   * The credential rows `teamServiceReadiness` reads, so a team file that
   * declares a trigger over tool nodes arms only when the team can act as
   * every service those nodes name (decision 15).
   */
  credentials: CredentialStore;
  /**
   * The 1Password client a team run resolves through, so an org-vault item
   * titled with the service arms the file the way it funds the run. Absent
   * on a deployment without one.
   */
  onePassword?: OnePasswordService;
}

export class WorkflowCollector implements ContentCollector {
  readonly kind = "workflows" as const;

  constructor(private readonly deps: WorkflowCollectorDeps) {}

  discover({ entries, source }: CollectorDiscoverContext): CollectorPass {
    const candidates: WorkflowCandidate[] = [];
    for (const entry of entries) {
      // A symlink's blob holds a path string and not a definition, so mode
      // 120000 is not a candidate.
      if (entry.type !== "blob" || entry.mode === "120000") continue;
      const root = rootFor(entry.path);
      if (root === null || !hasWorkflowExtension(entry.path)) continue;
      candidates.push({
        name: nameFromPath(entry.path),
        path: entry.path,
        blobSha: entry.sha,
        root,
      });
    }
    // Path order, so the manifest hash follows the commit and not the order
    // GitHub listed the tree in.
    candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return new WorkflowPass(
      candidates,
      source,
      this.deps.env,
      this.deps.plugins,
      this.deps.credentials,
      this.deps.onePassword,
    );
  }
}

interface WorkflowCandidate extends ContentManifestEntry {
  /** Which root claimed it. Under `.valet/workflows` a file with no `valet:`
   * key is a mistake worth naming, because that folder is unambiguous. Under
   * a top-level `workflows/` it is a file that belongs to something else. */
  root: string;
}

/** The root that claims `path`, or null. A file sitting directly in `.valet/`
 * is not under `.valet/workflows` and is never a candidate, which keeps this
 * away from `.valet/prebuild.yaml`. */
function rootFor(path: string): string | null {
  for (const root of WORKFLOW_ROOTS) {
    if (path.startsWith(`${root}/`) && path.length > root.length + 1) return root;
  }
  return null;
}

function hasWorkflowExtension(path: string): boolean {
  return WORKFLOW_FILE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** The file's base name without its extension. The file's own `name` key wins
 * once the body is read; this is the fallback, and the name the manifest
 * hashes before any body is read. */
function nameFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

class WorkflowPass implements CollectorPass {
  readonly kind = "workflows" as const;
  readonly readEntries: ContentManifestEntry[];
  readonly manifestEntries: ContentManifestEntry[];
  readonly text = new Map<string, string>();
  readonly warnings: string[] = [];
  readonly discovered: number;
  readonly excluded = 0;

  /** Set when a source that does not collect workflows held some anyway. */
  private readonly skippedForOwner: number;
  /** Workflows kept because a run of theirs has not settled, by name. */
  private disarmed: string[] = [];

  constructor(
    private readonly candidates: WorkflowCandidate[],
    source: ContentSourceRow,
    private readonly env: ValidateEnvironment | undefined,
    private readonly plugins: ValetPlugin[],
    private readonly credentials: CredentialStore,
    private readonly onePassword: OnePasswordService | undefined,
  ) {
    this.discovered = candidates.length;
    // A user source collects no workflows: personal workflow sync is out of
    // scope. `notice` says so once for the source rather than once per file.
    const collects = source.ownerType !== "user";
    this.skippedForOwner = collects ? 0 : candidates.length;
    this.readEntries = collects
      ? candidates.map(({ name, path, blobSha }) => ({ name, path, blobSha }))
      : [];
    this.manifestEntries = this.readEntries;
  }

  unreadWarning(path: string): string {
    return `${path} was in the repository listing and could not be read, so this workflow was not mirrored. Valet reads it again on the next sync. If it stays, check that the path is a file and not a symbolic link.`;
  }

  /**
   * Brings this source's mirrored workflows in line with what the commit
   * holds, keyed by path.
   *
   * A file that fails to parse or to validate is warned about and skipped,
   * and the row it already has is KEPT. That row is a working mirror of an
   * older commit, and a typo pushed to the file must not take a working
   * workflow away.
   */
  async reconcile(ctx: CollectorReconcileContext): Promise<CollectorReconcileResult> {
    return (await this.prepareReconcile(ctx))(ctx.db);
  }

  async prepareReconcile(ctx: CollectorReconcileContext): Promise<(db: AppDb) => Promise<CollectorReconcileResult>> {
    const { db, source, text, discovery, commitSha, now } = ctx;
    const warnings: string[] = [];
    let imported = 0;
    let updated = 0;

    if (source.ownerType === "user") {
      return async () => ({ imported, updated, deleted: 0, keptStale: [], warnings });
    }

    const existing = await db
      .select()
      .from(workflowDefinitions)
      .where(
        and(eq(workflowDefinitions.sourceId, source.id), eq(workflowDefinitions.origin, "repo")),
      );
    const byPath = new Map(
      existing.flatMap((row) => (row.upstreamPath === null ? [] : [[row.upstreamPath, row] as const])),
    );
    /**
     * Paths the repository still holds. Seeded from DISCOVERY, before any
     * body is read, because presence in the tree is what "still there" means
     * and a body is not needed to know it.
     *
     * Reading it from `text` instead would delete a mirror on a transient
     * fault: `readContents` treats a file it could not fetch as a normal
     * outcome, warns, and still calls reconcile, so one 404 in the window
     * between the tree read and the file read would take the definition, its
     * versions, its schedules and its webhook, and the next sync would
     * re-import the file under a new id that the old runs do not point at.
     * `skill-collector.ts` seeds from `readEntries` for the same reason.
     */
    const upstream = new Set(this.readEntries.map((entry) => entry.path));
    /** Files whose readiness check failed. Left as they were, and reported
     * deferred so the next poll checks them again at this commit. */
    const unchecked: string[] = [];
    const ingressPending: string[] = [];

    const incoming = new Map<string, { file: WorkflowFile; plan: TriggerPlan }>();
    for (const candidate of this.candidates) {
      const raw = text.get(candidate.path);
      if (raw === undefined) continue;

      const parsed = this.readFile(raw, candidate);
      if (parsed.kind === "skip") continue;
      if (parsed.kind === "warn") {
        warnings.push(parsed.message);
        continue;
      }

      const plan = await planTriggers(db, this.plugins, source, parsed.file, candidate.path, now());
      if (!plan.ok) {
        warnings.push(...plan.errors.map((e) => `${candidate.path}: ${e}`));
        continue;
      }
      incoming.set(candidate.path, { file: parsed.file, plan: plan.plan });
    }
    // Resolve this source against the complete validated commit, before writes.
    // Invalid or unread files cannot certify a call against an older mirror.
    const definitions = new Map<string, WorkflowDefinition | null>();
    for (const row of existing) {
      if (row.upstreamPath === null) continue;
      // Partial scans delete nothing below, so unseen rows remain callable.
      if (discovery === "directory-walk" && !upstream.has(row.upstreamPath)) continue;
      definitions.set(row.id, incoming.get(row.upstreamPath)?.file.definition ?? null);
    }

    const plans = new Map<string, TriggerPlan>();
    for (const candidate of this.candidates) {
      const parsed = incoming.get(candidate.path);
      if (!parsed) continue;
      // Decision 15: a triggered team run bills the team, so a team file
      // that declares a trigger over tool nodes arms only when the team can
      // act as every service those nodes name. Otherwise the file is
      // mirrored with its triggers unarmed, and the warning names each
      // blocked service and its fix.
      //
      // A fault in the check is this file's fault alone. A transient
      // credential-store error must not fail every file in the source, and
      // it must not disarm a trigger that was armed: the file is left as it
      // was and deferred, so the next poll checks it again.
      let gated: string | null;
      let ingressPlan = parsed.plan;
      try {
        gated = await teamTriggerGate(
          { db, credentials: this.credentials, plugins: this.plugins, onePassword: this.onePassword },
          source,
          parsed.file,
          definitions,
        );
        if (gated === null) {
          const ingressBlocked = await linearEventArmBlock(db,this.credentials,source.orgId,
            parsed.plan.subscriptions.flatMap(subscription => subscription.eventKeys));
          if (ingressBlocked) {
            warnings.push(`${candidate.path}: Linear event triggers remain off. ${ingressBlocked} Valet checks again on the next sync.`);
            ingressPending.push(candidate.path);
            ingressPlan = { ...parsed.plan, subscriptions: parsed.plan.subscriptions.filter(subscription =>
              !subscription.eventKeys.some(key => key.startsWith("linear."))) };
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(
          `${candidate.path}: the team's credential check failed (${message}), so Valet left this workflow as it was and armed nothing new. It checks again on the next sync.`,
        );
        unchecked.push(candidate.path);
        continue;
      }
      if (gated !== null) warnings.push(`${candidate.path}: ${gated}`);

      plans.set(candidate.path, gated === null ? ingressPlan : NO_TRIGGERS);
    }

    return async (db) => {
      for (const candidate of this.candidates) {
        const parsed = incoming.get(candidate.path);
        const plan = plans.get(candidate.path);
        if (!parsed || !plan) continue;

        const name = parsed.file.name ?? candidate.name;
        const row = byPath.get(candidate.path);
        if (row === undefined) {
          const id = newWorkflowId("wf");
          await db.insert(workflowDefinitions).values({
            id,
            // A mirrored row copies its owner from the source: a team source
            // produces team-owned workflows, an org source org-owned ones.
            orgId: source.orgId,
            ownerType: source.ownerType,
            ownerId: source.ownerId,
            name,
            definition: parsed.file.definition,
            origin: "repo",
            sourceId: source.id,
            upstreamPath: candidate.path,
            contentSha: candidate.blobSha,
            createdAt: now(),
            updatedAt: now(),
          });
          await snapshot(db, id, 1, name, parsed.file.definition, commitSha, now());
          for (const keys of await armTriggers(db, source, id, plan, now())) {
            warnings.push(
              `${candidate.path} declares two event blocks for ${keys}. Valet armed the first and ignored the rest; give them different event keys, or merge their filters.`,
            );
          }
          imported += 1;
          continue;
        }

        // The blob sha decides whether the FILE changed; the definition hash
        // decides whether a VERSION is worth minting. A rename of the file's
        // `name` key changes the row and mints nothing, matching the product
        // edit path.
        // The triggers reconcile on every pass, not only when the file moved:
        // they are rows another surface can change, and the file is the
        // authority for the ones it declares.
        for (const keys of await armTriggers(db, source, row.id, plan, now())) {
          warnings.push(
            `${candidate.path} declares two event blocks for ${keys}. Valet armed the first and ignored the rest; give them different event keys, or merge their filters.`,
          );
        }
        if (row.contentSha === candidate.blobSha && row.name === name) continue;
        await db
          .update(workflowDefinitions)
          .set({
            name,
            definition: parsed.file.definition,
            contentSha: candidate.blobSha,
            updatedAt: now(),
          })
          .where(eq(workflowDefinitions.id, row.id));
        if (canonicalJson(parsed.file.definition) !== canonicalJson(row.definition)) {
          await snapshot(
            db,
            row.id,
            await nextVersion(db, row.id),
            name,
            parsed.file.definition,
            commitSha,
            now(),
          );
        }
        updated += 1;
      }

      const stale = [...byPath.values()].filter(
        (row) => row.upstreamPath !== null && !upstream.has(row.upstreamPath),
      );
      // A narrower scan's absences prove nothing, so a cut tree deletes nothing.
      if (discovery === "directory-walk") {
        return {
          imported,
          updated,
          deleted: 0,
          keptStale: stale.map((row) => row.name),
          warnings,
          deferred: [...unchecked, ...ingressPending],
        };
      }

      let deleted = 0;
      const disarmed: string[] = [];
      const unsettled = await workflowsWithUnsettledRuns(
        db,
        stale.map((row) => row.id),
      );
      for (const row of stale) {
        if (unsettled.has(row.id)) {
          // The run keeps its own snapshot of the definition, so it finishes
          // either way. Deleting the row would orphan it from every list view,
          // so disarm instead: nothing new starts, and the next sync after the
          // run settles deletes the row.
          await disarmWorkflowTriggers(db, source.orgId, row.id);
          disarmed.push(row.name);
          continue;
        }
        // Scoped by source and origin a second time, so this delete stays off a
        // local workflow and off another source's rows even if the ids were
        // wrong.
        const confirmed = await db
          .select({ id: workflowDefinitions.id })
          .from(workflowDefinitions)
          .where(
            and(
              eq(workflowDefinitions.id, row.id),
              eq(workflowDefinitions.sourceId, source.id),
              eq(workflowDefinitions.origin, "repo"),
            ),
          );
        if (confirmed.length === 0) continue;
        await purgeWorkflowRows(db, source.orgId, row.id);
        deleted += 1;
      }
      this.disarmed = disarmed;
      for (const name of disarmed) {
        warnings.push(
          `${name}: this workflow's file is gone from the repository, and a run of it has not settled. Valet turned its triggers off and kept it. It is removed on the first sync after the run settles.`,
        );
      }

      // A disarmed workflow waits on a run, and no commit will land to move the
      // manifest when it settles. Reporting it deferred keeps the sync
      // incomplete, so the next poll re-reads and retries the delete. An
      // unchecked file is deferred for the same reason.
      return {
        imported,
        updated,
        deleted,
        keptStale: [],
        warnings,
        deferred: [...disarmed, ...unchecked, ...ingressPending],
      };
    };
  }

  /** One candidate's body to a workflow file, or to what to say about it. */
  private readFile(
    raw: string,
    candidate: WorkflowCandidate,
  ): { kind: "ok"; file: WorkflowFile } | { kind: "warn"; message: string } | { kind: "skip" } {
    let value: unknown;
    try {
      // YAML 1.2 parses JSON, so one parser reads both accepted forms.
      value = parseYaml(raw);
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : "";
      return {
        kind: "warn",
        message: `${candidate.path} is not valid YAML or JSON${detail}. Fix the file and push.`,
      };
    }

    const parsed = parseWorkflowFileValue(value, candidate.path, this.env ?? {});
    if (!parsed.ok) {
      // A file with no `valet:` key under a repository's own `workflows/` is
      // not a mistake: that folder belongs to the repository and may hold
      // anything. Under `.valet/workflows` the folder is unambiguous, so the
      // same file gets a warning naming the path.
      if (parsed.code === "unlabeled" && candidate.root !== ".valet/workflows") {
        return { kind: "skip" };
      }
      // The validator names the node and not the file, so the path goes in
      // front of its messages. Without it, the most common failure of this
      // feature reports a broken node and never says which file holds it.
      return { kind: "warn", message: `${candidate.path}: ${parsed.errors.join(" ")}` };
    }
    // The two collectors partition the path space by FOLDER, so a template
    // that sits in a workflow folder is mirrored by neither. Say so: silence
    // here reads as "Valet took it" to the person who wrote it. The message
    // names both halves of the fix, because moving the file is not enough on
    // a source that does not collect templates.
    if (parsed.file.kind !== "workflow") {
      return {
        kind: "warn",
        message: `${candidate.path} is a workflow template and it sits in a workflow folder, so Valet did not mirror it. Move it to .valet/templates/ and push, and check that this repository is set to collect templates.`,
      };
    }

    // A YAML anchor that refers to itself survives the validator, which only
    // walks `version`, `policy`, `nodes` and `edges`. It then throws out of
    // `JSON.stringify` in drizzle's jsonb encoder and in
    // `definitionVersionId`, which would abort the sync for every OTHER file
    // in the same pass. One file's mistake must cost that file only.
    try {
      JSON.stringify(parsed.file.definition);
    } catch {
      return {
        kind: "warn",
        message: `${candidate.path}: this workflow refers to itself, so Valet cannot store it. Look for a YAML anchor that includes the node holding it, and write the value out in full.`,
      };
    }
    return { kind: "ok", file: parsed.file };
  }

  notice(ctx: CollectorNoticeContext): string | null {
    const lines: string[] = [];
    if (this.skippedForOwner > 0) {
      const files = this.skippedForOwner === 1 ? "file" : "files";
      lines.push(
        `Valet found ${this.skippedForOwner} workflow ${files} here and mirrored none of them. Repository workflow sync applies to team sources and org sources. Add this repository as a team source to mirror them.`,
      );
    }
    if (ctx.discovery === "directory-walk" && ctx.keptStale.length > 0) {
      const kept = ctx.keptStale.length === 1 ? "workflow" : "workflows";
      lines.push(
        `${ctx.source.repoFullName} holds more files than Valet can read in one listing, so this scan was narrower than the one that mirrored these workflows. Valet kept ${ctx.keptStale.length} mirrored ${kept} it did not reach: ${ctx.keptStale.join(", ")}.`,
      );
    }
    if (this.disarmed.length > 0) {
      const wf = this.disarmed.length === 1 ? "workflow" : "workflows";
      lines.push(
        `Valet turned the triggers off on ${this.disarmed.length} mirrored ${wf} whose file is gone and whose run has not settled: ${this.disarmed.join(", ")}. They are removed on the first sync after the runs settle.`,
      );
    }
    return lines.length === 0 ? null : lines.join("\n");
  }
}

/**
 * What a file's `schedule` and `events` blocks become, once every value that
 * can be refused has been. Empty on a file that declares neither, and on one
 * decision 9's gate holds back; either way the reconcile below then removes
 * whatever the file used to declare.
 */
interface TriggerPlan {
  schedule: {
    name: string;
    cron: string;
    timezone: string;
    nextFireAt: number;
  } | null;
  subscriptions: Array<{
    name: string;
    eventKeys: string[];
    filters: SubscriptionFilter[];
  }>;
}

const NO_TRIGGERS: TriggerPlan = { schedule: null, subscriptions: [] };

/**
 * Checks a file's declared triggers, and returns what to write.
 *
 * Nothing is written here. Decision 8 reuses the install path's validation
 * ORDER: a bad cron or a filter naming an undeclared field fails the file and
 * reports on the source row, rather than arming a trigger that can never
 * fire. Failing the file is why this runs before the definition is mirrored.
 *
 * A webhook is never planned. The bearer secret is the primary key of
 * `workflow_webhooks`, so a file that declared one would publish the secret
 * in the repository. Arm a webhook from the Triggers page instead; it keys
 * off `workflow_id` and survives every resync.
 */
async function planTriggers(
  db: AppDb,
  plugins: ValetPlugin[],
  source: ContentSourceRow,
  file: WorkflowFile,
  path: string,
  now: number,
): Promise<{ ok: true; plan: TriggerPlan } | { ok: false; errors: string[] }> {
  const errors: string[] = [];
  let schedule: TriggerPlan["schedule"] = null;

  if (file.schedule !== undefined) {
    const timezone = file.schedule.timezone ?? "UTC";
    // The same parser the install path calls, so a cron this accepts is one
    // the scheduler can fire.
    const next = nextFireAt(file.schedule.cron, timezone, now);
    if (!next.ok) errors.push(next.error);
    else {
      schedule = {
        name: file.schedule.name,
        cron: file.schedule.cron,
        timezone,
        nextFireAt: next.at,
      };
    }
  }

  const subscriptions: TriggerPlan["subscriptions"] = [];
  for (const event of file.events ?? []) {
    // `matchChanged: false` runs `validateSubscription` and RETURNS BEFORE
    // `enforceMentionScope`. That is deliberate and it is a real gap worth
    // naming rather than hiding behind the flag: the mention gate narrows a
    // Slack subscription to the creator's own mentions, and a file has no
    // creator whose identity could be injected. So a file CAN declare a
    // broader Slack match than a person could create through the UI. The
    // control on that is decision 10 — only a team admin or an org admin can
    // add a source that collects workflows at all — and the file is in a
    // repository the team can read. Widening this to the source's creator
    // would silently scope an org's automation to one person's mentions,
    // which is worse.
    const write = await validateSubscriptionWrite(
      db,
      plugins,
      {
        name: event.name ?? event.eventKeys.join(", "),
        eventKeys: event.eventKeys,
        filters: event.filters ?? [],
        target: { kind: "workflow", workflowId: "pending" },
      },
      { matchChanged: false, anyChannel: false, creatorUserId: source.createdBy ?? source.ownerId },
    );
    if (!write.ok) {
      errors.push(write.error);
      continue;
    }
    subscriptions.push({
      name: event.name ?? event.eventKeys.join(", "),
      eventKeys: event.eventKeys,
      // The validator's own filters, not the file's: it is the value that
      // passed, and dropping it would arm a subscription on unchecked input.
      filters: write.filters,
    });
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors: errors.map((e) => `${e} Fix ${path} and push; nothing from this file was mirrored.`),
    };
  }
  return { ok: true, plan: { schedule, subscriptions } };
}

/**
 * Brings the `origin='repo'` triggers of one mirrored workflow in line with
 * its file. Every write is scoped by `workflow_id` AND `origin='repo'`, so a
 * trigger a person armed on the same workflow is never touched: decision 8
 * keeps the Triggers page open on a mirrored workflow, and a webhook armed
 * there has to survive.
 *
 * A block removed from the file disarms its trigger, which is the whole
 * reason this reconciles rather than only inserting.
 */
async function armTriggers(
  db: AppDb,
  source: ContentSourceRow,
  workflowId: string,
  plan: TriggerPlan,
  now: number,
): Promise<string[]> {
  const existing = await db
    .select()
    .from(workflowSchedules)
    .where(and(eq(workflowSchedules.workflowId, workflowId), eq(workflowSchedules.origin, "repo")));

  if (plan.schedule === null) {
    if (existing.length > 0) {
      await db
        .delete(workflowSchedules)
        .where(
          and(eq(workflowSchedules.workflowId, workflowId), eq(workflowSchedules.origin, "repo")),
        );
    }
  } else {
    const wanted = plan.schedule;
    const current = existing[0];
    // One schedule per file: the envelope carries one `schedule` block. A
    // second row can only come from an older shape, so it goes.
    for (const extra of existing.slice(1)) {
      await db.delete(workflowSchedules).where(eq(workflowSchedules.id, extra.id));
    }
    if (current === undefined) {
      await db.insert(workflowSchedules).values({
        id: newWorkflowId("wfsched"),
        orgId: source.orgId,
        // The schedule follows its workflow, which follows its source.
        ownerType: source.ownerType,
        ownerId: source.ownerId,
        targetKind: "workflow",
        workflowId,
        name: wanted.name,
        cron: wanted.cron,
        timezone: wanted.timezone,
        enabled: true,
        origin: "repo",
        nextFireAt: wanted.nextFireAt,
        createdBy: source.createdBy ?? source.ownerId,
        createdAt: now,
        updatedAt: now,
      });
    } else if (
      current.cron !== wanted.cron ||
      current.timezone !== wanted.timezone ||
      current.name !== wanted.name
    ) {
      // `next_fire_at` moves only when the cron or the zone did. Rewriting it
      // on every poll would push a due schedule forward forever.
      const reschedule = current.cron !== wanted.cron || current.timezone !== wanted.timezone;
      await db
        .update(workflowSchedules)
        .set({
          name: wanted.name,
          cron: wanted.cron,
          timezone: wanted.timezone,
          updatedAt: now,
          ...(reschedule ? { nextFireAt: wanted.nextFireAt } : {}),
        })
        .where(eq(workflowSchedules.id, current.id));
    }
  }

  // Subscriptions are keyed by the event keys they carry, which is the only
  // identity a file gives them.
  const subs = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.orgId, source.orgId), eq(eventSubscriptions.origin, "repo")));
  const mine = subs.filter((row) => {
    if (typeof row.target !== "object" || row.target === null) return false;
    const target = row.target as { kind?: string; workflowId?: string };
    return target.kind === "workflow" && target.workflowId === workflowId;
  });
  const keyOf = (keys: string[]): string => [...keys].sort().join("\u0000");
  // Built by hand rather than from the array, so two blocks naming the same
  // event keys do not silently collapse into whichever came last. The first
  // wins and `armTriggers` reports the rest through its return value.
  const wanted = new Map<string, TriggerPlan["subscriptions"][number]>();
  const collided: string[] = [];
  for (const sub of plan.subscriptions) {
    const key = keyOf(sub.eventKeys);
    if (wanted.has(key)) collided.push(sub.eventKeys.join(", "));
    else wanted.set(key, sub);
  }

  for (const row of mine) {
    const key = keyOf((row.eventKeys as string[]) ?? []);
    const want = wanted.get(key);
    if (want === undefined) {
      await db.delete(eventSubscriptions).where(eq(eventSubscriptions.id, row.id));
      continue;
    }
    wanted.delete(key);
    if (row.name !== want.name || canonicalJson(row.filters) !== canonicalJson(want.filters)) {
      await db
        .update(eventSubscriptions)
        .set({ name: want.name, filters: want.filters, updatedAt: now })
        .where(eq(eventSubscriptions.id, row.id));
    }
  }
  for (const want of wanted.values()) {
    await db.insert(eventSubscriptions).values({
      id: newWorkflowId("evsub"),
      orgId: source.orgId,
      // An ORG owner is the exception, as it is for a file-armed schedule:
      // `canMutateSubscription` in `routes/events.ts` returns true for any
      // org member on an org-owned row, so copying the owner here would hand
      // every member the power to repoint or delete a subscription an admin
      // published. The row stays with whoever created the source. Delivery is
      // unaffected: the dispatcher starts the run as the DEFINITION's owner.
      ...(source.ownerType === "org"
        ? { ownerType: "user" as const, ownerId: source.createdBy ?? source.ownerId }
        : { ownerType: source.ownerType, ownerId: source.ownerId }),
      name: want.name,
      eventKeys: want.eventKeys,
      filters: want.filters,
      target: { kind: "workflow", workflowId },
      enabled: true,
      origin: "repo",
      createdBy: source.createdBy ?? source.ownerId,
      createdAt: now,
      updatedAt: now,
    });
  }
  return collided;
}

/**
 * Decision 15. A team-owned file that declares a trigger over tool nodes
 * arms only when `teamServiceReadiness` reports every service ready: a
 * triggered run bills the team, and a tool node whose service the team
 * cannot act as fails on every fire. The sync still mirrors the
 * definition, and the message names each blocked service with its fix.
 * Org sources are unaffected: org credential escalation already works.
 *
 * Returns null when the triggers may arm.
 */
async function teamTriggerGate(
  deps: TeamServiceReadinessDeps,
  source: ContentSourceRow,
  file: WorkflowFile,
  definitions: ReadonlyMap<string, WorkflowDefinition | null>,
): Promise<string | null> {
  if (source.ownerType !== "team") return null;
  if (file.schedule === undefined && (file.events === undefined || file.events.length === 0)) {
    return null;
  }
  // A call node carries tool nodes the team must fund too (TKAI-443), so a
  // file whose only work is a call is still judged.
  if (toolNodesOf(file.definition).length === 0 && workflowCallsOf(file.definition).length === 0) return null;
  const readiness = await teamServiceReadiness(deps, {
    orgId: source.orgId,
    teamId: source.ownerId,
    definition: file.definition,
    definitions,
  });
  const refusals = teamArmRefusals(readiness);
  if (refusals.length === 0) return null;
  // The readiness reasons are caller-neutral; the step that follows the fix
  // in THIS flow is the resync, and it is named once after them.
  const reasons = refusals.map((refusal) => refusal.reason).join(" ");
  return `this workflow declares a trigger over tool actions the team cannot act as yet, so Valet mirrored the workflow and left the trigger off. ${reasons} Valet arms it after you connect the service.`;
}

/** Which of `ids` hold a run that has not settled. One query, and none at all
 * when nothing is stale. */
async function workflowsWithUnsettledRuns(db: AppDb, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ workflowId: workflowRuns.workflowId })
    .from(workflowRuns)
    .where(and(inArray(workflowRuns.workflowId, ids), hasUnsettledWorkflowRun()));
  return new Set(rows.map((row) => row.workflowId));
}

/** A version row carrying the commit that produced it, so the version list
 * reads as one timeline whether a push or a person made the entry. */
async function snapshot(
  db: AppDb,
  workflowId: string,
  version: number,
  name: string,
  definition: unknown,
  commitSha: string,
  now: number,
): Promise<void> {
  await db.insert(workflowVersions).values({
    id: newWorkflowId("wfv"),
    workflowId,
    version,
    name,
    definition,
    origin: "repo",
    sourceCommit: commitSha,
    createdAt: now,
  });
}

async function nextVersion(db: AppDb, workflowId: string): Promise<number> {
  const rows = await db
    .select({ version: workflowVersions.version })
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, workflowId))
    .orderBy(workflowVersions.version);
  return (rows[rows.length - 1]?.version ?? 0) + 1;
}
