import { linearEventArmBlock } from "../services/linear-ingress.js";
/**
 * Workflow templates — the gallery's server half.
 *
 * A template is a `WorkflowDefinition` a plugin ships (`ValetPlugin.
 * templates`, `@valet/engine`), plus the copy the gallery needs to explain
 * it before install. This module does three things and nothing else:
 *
 *   1. Aggregates the templates every loaded plugin contributes, then the
 *      seeded catalog the host ships itself (`template-definitions.ts`).
 *      There is no registry object — plugin-contributed things are read
 *      straight off `providers.plugins`, the same way `/api/plugins` reads
 *      services and the event catalog reads `plugin.triggers`.
 *   2. Derives the summary the gallery renders: the services a template
 *      needs and whether the principal the install would act as has
 *      connected them (the caller, or the team the gallery is scoped to),
 *      the run-form inputs, and the caveats. Most caveats are read out of
 *      the definition rather than written by an author, because derived
 *      copy cannot drift away from what the workflow actually does. An
 *      author's own caveats are kept, for the limits a definition cannot
 *      show.
 *   3. Installs a template as a real, owned workflow.
 *
 * Install writes the definition, its version-1 snapshot, and the cron
 * schedule in ONE transaction. The schedule row names a workflow id minted
 * inside that same transaction, so there is no window in which an armed
 * schedule points at a workflow that does not exist: either every row
 * lands or none does. No compensating delete is needed, and none exists —
 * a rollback path is itself a thing that can fail.
 *
 * Installing one template twice is allowed and produces two independent
 * workflows. Two installs of a batch template with different parameters is
 * the intended use, so refusing the second would be wrong.
 */
import { githubAppRepositoryAccess } from "../services/github-app.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, or } from "drizzle-orm";
import type { ActionPlugin, CredentialOwner, CredentialStore, ValetPlugin, WorkflowTemplate } from "@valet/engine";
import {
  collectTemplatePaths,
  resolveTriggerInput,
  normalizeInputType,
  triggerDataSchema,
  type ForeachNode,
  type ValidateEnvironment,
  type WorkflowDefinition,
  type WorkflowInputDefinition,
} from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import {
  eventSubscriptions,
  workflowDefinitions,
  workflowSchedules,
  workflowTemplates,
  workflowVersions,
} from "../schema/index.js";
import { builtinWorkflowTemplates } from "./template-definitions.js";
import { isTeamMember, listTeamsForUser, lockTeamForOwnership } from "../services/teams.js";
import { orgProvidedServiceSet, unavailableServiceSet } from "../services/integration-availability.js";
import type { OnePasswordService } from "../services/onepassword.js";
import {
  teamArmRefusals,
  teamServiceReadiness,
  withNextStep,
  type TeamServiceReadiness,
} from "./team-service-readiness.js";
import { buildOrgValidateEnvironment, buildValidateEnvironment } from "./validation-env.js";
import { TIER_SET } from "../services/model-tiers.js";
import { nextFireAt } from "./schedule-service.js";
import { toolNodesOf, workflowCallsOf } from "./tool-nodes.js";
// Same validator the Triggers UI posts through (`routes/events.ts`), so a
// template-declared subscription and a hand-made one are held to one rule.
// `trigger-service.ts` set the precedent for importing it from a service.
import { validateSubscriptionWrite } from "../events/subscription-write.js";
import type { SubscriptionFilter } from "../events/match.js";
import { newWorkflowId, validateDefinitionInput, type WorkflowOwner } from "./service.js";
import type {
  WorkflowTemplateInput,
  WorkflowTemplateRequirement,
  WorkflowTemplateSummary,
} from "../wire/types.js";

/** Foreach's own default cap (`nodes/foreach.ts`), repeated here only to
 * word the caveat when a template leaves `maxItems` off. */
const FOREACH_DEFAULT_MAX_ITEMS = 100;

/** `WorkflowTemplateSchedule.timezone` is optional; the schedules table
 * defaults the same way (`schema/index.ts`). */
const DEFAULT_TIMEZONE = "UTC";

/** One filter as the `event_subscriptions.filters` column holds it — the
 * template's `fromInput` indirection is already resolved to a value here. */
interface SubscriptionFilterRow {
  field: string;
  op: "eq" | "in" | "prefix" | "contains";
  value: string | string[];
}

export interface TemplateServiceDeps {
  db: AppDb;
  plugins: ValetPlugin[];
  actionPluginByService: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;
  credentials: CredentialStore;
  /** The 1Password client a team run resolves through, so a team install
   * is gated on the same vault lookup. Absent on a deployment without one. */
  onePassword?: OnePasswordService;
  /** Provider seam for the exact repository installation check. */
  github?: { apiUrl?: string; fetchImpl?: typeof fetch };
}

/** A template plus what contributed it, so every message can name the place
 * an author has to open to fix the template. The name is a plugin name, or
 * `CATALOG_SOURCE` for a template the host ships itself. */
export interface OwnedTemplate {
  pluginName: string;
  template: WorkflowTemplate;
}

// ─── Aggregation ─────────────────────────────────────────────────────────

/**
 * Every loaded plugin's templates, in plugin order.
 *
 * A repeated `id` THROWS, naming both plugins — the same rule
 * `plugins/assemble.ts` applies to a repeated skill name and a repeated
 * action service. We ship the plugins, so a collision is a build-time bug
 * and must be loud; the id is a lookup key, and the quiet alternative
 * makes one of the two templates permanently unreachable through
 * `POST /api/templates/:id/install`.
 */
export function listPluginTemplates(plugins: ValetPlugin[]): OwnedTemplate[] {
  const out: OwnedTemplate[] = [];
  const ownerById = new Map<string, string>();
  for (const plugin of plugins) {
    for (const template of plugin.templates ?? []) {
      const owner = ownerById.get(template.id);
      if (owner !== undefined) {
        throw new Error(
          `plugin template collision: "${template.id}" is shipped by both "${owner}" and ` +
            `"${plugin.name}". Rename one of them.`,
        );
      }
      ownerById.set(template.id, plugin.name);
      out.push({ pluginName: plugin.name, template });
    }
  }
  return out;
}

/**
 * Source name used where a plugin name would go, for a template the host
 * ships itself. Every message that names a plugin ("open this plugin to fix
 * the template") stays truthful with it: it points at the seeded catalog
 * instead of at a plugin that does not own the template.
 */
export const CATALOG_SOURCE = "workflows catalog";

/**
 * Rank of a template that declares none.
 *
 * `Number.MAX_SAFE_INTEGER` and not `Infinity`, because the comparator
 * subtracts: `Infinity - Infinity` is NaN, and a NaN comparator leaves the
 * order of two unranked templates up to the sort implementation.
 */
const UNRANKED = Number.MAX_SAFE_INTEGER;

/**
 * Gallery order, in one place.
 *
 * `WorkflowTemplate.rank` is the whole rule: lower first, unranked last,
 * and source order everywhere the ranks tie. `Array.prototype.sort` is
 * stable, so the source order the aggregation produced — plugin order, then
 * the seeded catalog — survives as the tie-break. Ranking one template
 * therefore moves that one template and nothing else.
 *
 * The order is DATA. A template that belongs at the top says so in its own
 * manifest, and this function never learns any template's id.
 */
function byRank(templates: OwnedTemplate[]): OwnedTemplate[] {
  return [...templates].sort((a, b) => (a.template.rank ?? UNRANKED) - (b.template.rank ?? UNRANKED));
}

/**
 * Everything the gallery can offer, in the order the gallery shows it:
 * ranked templates first (see `byRank`), then everything unranked in
 * aggregation order — each loaded plugin's templates in plugin order, then
 * the seeded catalog.
 *
 * The seeded catalog is aggregated LAST so a plugin that ships a better
 * template for the same job appears above the generic one without either
 * side needing a rank.
 *
 * A seeded id that a plugin already claims THROWS, for the reason
 * `listPluginTemplates` throws on a repeated plugin id: the id is the
 * install route's lookup key, and the quiet alternative makes one of the
 * two templates permanently unreachable. We ship both sides, so a collision
 * is our bug and must be loud.
 */
export function listCatalogTemplates(plugins: ValetPlugin[]): OwnedTemplate[] {
  const out = listPluginTemplates(plugins);
  const ownerById = new Map(out.map((owned) => [owned.template.id, owned.pluginName]));
  for (const template of builtinWorkflowTemplates) {
    const owner = ownerById.get(template.id);
    if (owner !== undefined) {
      throw new Error(
        `workflow template collision: "${template.id}" is shipped by both "${owner}" and the ` +
          `${CATALOG_SOURCE}. Rename one of them.`,
      );
    }
    ownerById.set(template.id, CATALOG_SOURCE);
    out.push({ pluginName: CATALOG_SOURCE, template });
  }
  return byRank(out);
}

export function findCatalogTemplate(plugins: ValetPlugin[], id: string): OwnedTemplate | null {
  return listCatalogTemplates(plugins).find((t) => t.template.id === id) ?? null;
}

/** What a mirrored template's `pluginName` reads as: the repository it came
 * from, so every message can still name the place to go and fix it. */
function mirroredSourceName(repoFullName: string, path: string): string {
  return `${repoFullName}:${path}`;
}

/**
 * The code catalog, then the mirrored templates this caller can reach: the
 * org's rows, and the rows of every team they belong to.
 *
 * Order carries the precedence rule. A shipped template always outranks a
 * mirrored one claiming its id, because we ship one side and a repository
 * owns the other; the sync also refuses such an id with a warning, so this
 * order is the second line rather than the first.
 *
 * `listCatalogTemplates` stays pure and code-only. This is the function every
 * owner-scoped read goes through instead.
 */
export async function listCatalogTemplatesForOwner(
  deps: TemplateServiceDeps,
  caller: { userId: string; orgId: string },
): Promise<OwnedTemplate[]> {
  const code = listCatalogTemplates(deps.plugins);
  const teamIds = (await listTeamsForUser(deps.db, caller.userId)).map((team) => team.id);
  const reach = or(
    and(eq(workflowTemplates.ownerType, "org"), eq(workflowTemplates.ownerId, caller.orgId)),
    teamIds.length > 0
      ? and(eq(workflowTemplates.ownerType, "team"), inArray(workflowTemplates.ownerId, teamIds))
      : undefined,
  );
  const rows = await deps.db
    .select()
    .from(workflowTemplates)
    .where(and(eq(workflowTemplates.orgId, caller.orgId), reach))
    .orderBy(workflowTemplates.templateId);

  const seen = new Set(code.map((owned) => owned.template.id));
  const mirrored: OwnedTemplate[] = [];
  for (const row of rows) {
    // A shipped id wins, and so does the first mirrored row of two teams that
    // both publish one id. Skipping rather than throwing: a repository owns
    // this side, and a build-time throw would take the whole gallery down for
    // a mistake nobody here can fix.
    if (seen.has(row.templateId)) continue;
    seen.add(row.templateId);
    const source = row.sourceId === null ? "a repository" : row.sourceId;
    mirrored.push({
      pluginName: mirroredSourceName(source, row.upstreamPath),
      template: row.template as WorkflowTemplate,
    });
  }
  return [...code, ...mirrored];
}

/** One template the caller can reach, shipped or mirrored. */
export async function findTemplateForOwner(
  deps: TemplateServiceDeps,
  caller: { userId: string; orgId: string },
  id: string,
): Promise<OwnedTemplate | null> {
  return (await listCatalogTemplatesForOwner(deps, caller)).find((t) => t.template.id === id) ?? null;
}

// ─── Definition introspection ────────────────────────────────────────────

function foreachNodesOf(definition: WorkflowDefinition): ForeachNode[] {
  const out: ForeachNode[] = [];
  for (const node of definition.nodes) {
    if (node.type === "foreach") out.push(node);
  }
  return out;
}

/**
 * The model specs a definition names, top level or in a foreach body. Only
 * `llm` and `session` nodes carry one; every other node type inherits the
 * run's own model.
 */
function modelSpecsOf(definition: WorkflowDefinition): string[] {
  const specs: string[] = [];
  const read = (node: WorkflowDefinition["nodes"][number] | ForeachNode["body"]): void => {
    if (node.type !== "llm" && node.type !== "session") return;
    if (typeof node.model === "string" && node.model.trim() !== "") specs.push(node.model);
  };
  for (const node of definition.nodes) {
    read(node);
    if (node.type === "foreach") read(node.body);
  }
  return [...new Set(specs)];
}

/**
 * Why this organization cannot install the template, or null when it can.
 *
 * One function answers for the gallery card and for the install gate, so
 * the card never disables a button the install would have accepted, and the
 * install never refuses a card that read as ready. The message names both
 * remedies the reader has: the organization approves and activates the
 * model, or it adds a key for the model's provider. Both live on the same
 * settings page.
 *
 * A size tier is named only when the template uses one. A tier the
 * organization cannot serve has its own remedy — repoint the tier — and a
 * template that names no tier must not send the reader to look for one.
 */
export function orgModelBlockReason(
  templateId: string,
  definition: WorkflowDefinition,
  env: ValidateEnvironment,
): string | null {
  const isKnown = env.isKnownModel;
  if (!isKnown) return null;
  const blocked = modelSpecsOf(definition).filter((spec) => isKnown(spec) !== true);
  if (blocked.length === 0) return null;
  const tiers = blocked.filter((spec) => TIER_SET.has(spec.trim().toLowerCase()));
  const models = blocked.filter((spec) => !TIER_SET.has(spec.trim().toLowerCase()));
  const remedies: string[] = [];
  if (models.length > 0) {
    const named = models.map((spec) => `"${spec}"`).join(", ");
    remedies.push(
      `In Settings > Models, approve and activate ${named}, or add a key for the provider that serves ${models.length === 1 ? "it" : "them"}.`,
    );
  }
  if (tiers.length > 0) {
    const named = tiers.map((spec) => `"${spec}"`).join(", ");
    remedies.push(
      `In Settings > Models, point size ${tiers.length === 1 ? "tier" : "tiers"} ${named} at a provider this organization holds a key for.`,
    );
  }
  return (
    `Template "${templateId}" names a model this organization cannot use. ${remedies.join(" ")}`
  );
}

/**
 * The credential-service key a tool node's service resolves to, and
 * whether that service needs a connection at all.
 *
 * Mirrors `plugins/assemble.ts#withCredentialRequirement`: a plugin that
 * declares a credential for the service is saying its actions need one. A
 * service with no credential declaration (the workflows plugin's own
 * actions) needs nothing connected, so reporting it as unconnected would
 * block an install for no reason.
 */
function credentialServiceFor(
  entry: { plugin: ValetPlugin; actionPlugin: ActionPlugin },
): { service: string; required: boolean; dynamic: boolean } {
  const service = entry.actionPlugin.credentialService ?? entry.actionPlugin.service;
  const declared = (entry.plugin.credentials ?? []).some((c) => (c.service ?? entry.plugin.name) === service);
  return {
    service,
    required: entry.actionPlugin.requiresCredential ?? declared,
    dynamic: entry.actionPlugin.resolveActions !== undefined,
  };
}

/**
 * Services this definition's tool nodes need, with the caller's connection
 * state. `connectedServices` is the caller's own credential set — the same
 * read `/api/plugins` uses, so the gallery and the integrations page never
 * disagree about what is connected.
 *
 * `unavailableServices` is the set this deployment or organization has not
 * configured (`unavailableServiceSet`, integration-availability design).
 * A service in it can never be connected by the reader, so the card must
 * say who configures it rather than offer a connect path. An absent set
 * means the caller knows of no unconfigured service, which is the right
 * answer for a caller with no organization in hand.
 */
export function templateRequirements(
  definition: WorkflowDefinition,
  actionPluginByService: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>,
  connectedServices: ReadonlySet<string>,
  unavailableServices: ReadonlySet<string> = new Set(),
): WorkflowTemplateRequirement[] {
  const byService = new Map<string, WorkflowTemplateRequirement>();
  for (const node of toolNodesOf(definition)) {
    const entry = actionPluginByService.get(node.service);
    // An unknown service never reaches here: the definition validator
    // rejects it, and `summarizeTemplate` drops a template that fails
    // validation before this runs.
    if (!entry) continue;
    const { service, required, dynamic } = credentialServiceFor(entry);
    if (byService.has(service)) continue;
    byService.set(service, {
      service,
      connected: required ? connectedServices.has(service) : true,
      ...(dynamic ? { dynamic: true } : {}),
      ...(unavailableServices.has(service) ? { unconfigured: true } : {}),
    });
  }
  return [...byService.values()];
}

function primitiveDefault(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

/**
 * Run-form fields derived from the trigger's `dataSchema` — the single
 * declaration of a template's inputs. `hidden` entries are dropped, and
 * `label` falls back to the field name so a raw field id never reaches a
 * person.
 *
 * Object and array fields are dropped too: the install dialog collects
 * primitives, and an array input belongs to a RUN (the batch templates
 * collect theirs in the workflow's own run dialog), not to an install.
 */
export function templateInputs(
  schema: Record<string, WorkflowInputDefinition> | undefined,
): WorkflowTemplateInput[] {
  if (!schema) return [];
  const inputs: WorkflowTemplateInput[] = [];
  for (const [name, def] of Object.entries(schema)) {
    if (def.hidden === true) continue;
    const type = normalizeInputType(def.type);
    if (type !== "string" && type !== "number" && type !== "boolean") continue;
    const fallback = primitiveDefault(def.default);
    inputs.push({
      name,
      type,
      label: def.label ?? name,
      ...(def.placeholder !== undefined ? { placeholder: def.placeholder } : {}),
      ...(def.description !== undefined ? { description: def.description } : {}),
      required: def.required === true,
      ...(fallback !== undefined ? { default: fallback } : {}),
    });
  }
  return inputs;
}

/**
 * Caveats, derived from the definition rather than written by hand.
 *
 * Three things can surprise the person who installs a template, and all
 * three are readable from the definition:
 *
 *   - A service that resolves its actions at run time (an MCP-backed
 *     service). The action NAME is unverifiable when the definition is
 *     saved, so a renamed action fails on the first run.
 *   - A high-risk action. Org policy turns it into an approval gate, and
 *     the run parks until a person answers. On a scheduled workflow that
 *     is worse than a failure — parked runs accumulate unattended.
 *   - A foreach cap. It truncates silently at the node; naming the number
 *     here is what makes a short batch visible before it happens.
 *
 * `authored` is the template's own caveat list, used only to suppress a
 * derived line the author already wrote. The approval-gate line is never
 * suppressed — see its comment.
 */
export function templateCaveats(
  definition: WorkflowDefinition,
  actionPluginByService: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>,
  scheduled: boolean,
  authored: readonly string[] = [],
): string[] {
  const caveats: string[] = [];
  const dynamicSeen = new Set<string>();
  const riskySeen = new Set<string>();

  // An author who already wrote about a limit does not need our sentence
  // about it too — two lines saying one thing reads as a mistake on the
  // card. The token is what makes the two lines the same one: the service
  // name, the action id, or the cap itself. When the match misses, the
  // reader sees both lines, which is the behavior with no rule at all.
  const lower = authored.map((c) => c.toLowerCase());
  const alreadySaid = (token: string): boolean => lower.some((c) => c.includes(token.toLowerCase()));

  for (const node of toolNodesOf(definition)) {
    const entry = actionPluginByService.get(node.service);
    if (!entry) continue;
    const { dynamic } = credentialServiceFor(entry);
    if (dynamic) {
      if (dynamicSeen.has(node.service)) continue;
      dynamicSeen.add(node.service);
      if (alreadySaid(node.service)) continue;
      caveats.push(
        `The ${node.service} step finds its action when the workflow runs. If ${node.service} renamed the action, the run fails. Open the run to read the error.`,
      );
      continue;
    }
    const action = entry.actionPlugin.actions.find(
      (a) => a.id === node.action || a.id === `${node.service}.${node.action}`,
    );
    if (!action) continue;
    if (action.riskLevel !== "high" && action.riskLevel !== "critical") continue;
    const fqid = `${node.service}.${node.action}`;
    if (riskySeen.has(fqid)) continue;
    riskySeen.add(fqid);
    // A gate on an unattended run is the one thing an author must not be
    // able to talk us out of saying, so this line is never suppressed.
    caveats.push(
      scheduled
        ? `The ${fqid} step is ${action.riskLevel} risk. An org policy can hold it for approval, and a scheduled run then waits until a person answers.`
        : `The ${fqid} step is ${action.riskLevel} risk. An org policy can hold the run until a person approves it.`,
    );
  }

  for (const node of foreachNodesOf(definition)) {
    const cap = node.maxItems ?? FOREACH_DEFAULT_MAX_ITEMS;
    if (alreadySaid(String(cap))) continue;
    caveats.push(`Each run processes at most ${cap} items. The workflow reports the count it did not process.`);
  }

  return caveats;
}

// ─── Summaries ───────────────────────────────────────────────────────────

export interface SummarizeResult {
  githubEvents: boolean;
  summary: WorkflowTemplateSummary;
  definition: WorkflowDefinition;
}

/**
 * Summarizes one template, or reports why it cannot be offered.
 *
 * The definition goes through `validateDefinitionInput` with the ORG-LESS
 * environment, so a template that names an unknown model, an unknown
 * action, or a wrong node-reference path is caught here — at list time,
 * with the validator's own message — instead of on the first run. A
 * failure here means the SHIPPED template is broken, which is why the
 * gallery logs it and the install route answers 500.
 *
 * The org's own model policy is deliberately not applied here. It belongs
 * to the org, not to the template, and applying it would empty the gallery
 * for an organization whose approved list omits the bundled models, under a
 * log line that calls every shipped template invalid. `installWorkflowTemplate`
 * applies it instead, on the baked definition, so an install can never
 * write a workflow the organization could not have saved itself.
 */
export function summarizeTemplate(
  owned: OwnedTemplate,
  actionPluginByService: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>,
  connectedServices: ReadonlySet<string>,
  unavailableServices: ReadonlySet<string> = new Set(),
): { ok: true; value: SummarizeResult } | { ok: false; errors: string[] } {
  const validation = validateDefinitionInput(
    owned.template.definition,
    buildValidateEnvironment(actionPluginByService),
  );
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const definition = validation.definition;
  const schedule = owned.template.schedule;
  const authored = owned.template.caveats ?? [];
  return {
    ok: true,
    value: {
      githubEvents: owned.template.events?.some((event) => event.eventKeys.some((key) => key.startsWith("github."))) ?? false,
      definition,
      summary: {
        id: owned.template.id,
        name: owned.template.name,
        description: owned.template.description,
        steps: owned.template.steps,
        schedule: schedule ? { cron: schedule.cron, timezone: schedule.timezone ?? DEFAULT_TIMEZONE } : null,
        requires: templateRequirements(
          definition,
          actionPluginByService,
          connectedServices,
          unavailableServices,
        ),
        inputs: templateInputs(triggerDataSchema(definition)),
        // The author's own caveats come first: they carry knowledge the
        // definition cannot show. The derived ones follow, and cannot go
        // stale, because they are read from the definition every time.
        caveats: [
          ...authored,
          ...templateCaveats(definition, actionPluginByService, schedule !== undefined, authored),
        ],
        // The org's answer is stamped by `listWorkflowTemplateSummaries`,
        // which holds the org environment. A summary taken without it is
        // installable as far as this function can tell.
        installable: true,
      },
    },
  };
}

/**
 * The gallery listing, in gallery order (`listCatalogTemplates`).
 *
 * A template whose definition fails validation is EXCLUDED and logged with
 * the plugin name, the template id, and the validator's errors. Nothing
 * else can be done with it: the gallery must not offer a workflow that the
 * create path would refuse, and hiding one broken card is better than
 * failing the whole page. The template-contract test fails CI on the same
 * condition, so a broken template never reaches a deployment silently.
 *
 * The caller is named by user AND organization, because a card reports two
 * different states. `connected` is the credential set of the principal the
 * install would act as: the person, or the team named by `opts.teamId`. A
 * service this organization has not configured is reported separately
 * (`WorkflowTemplateRequirement.unconfigured`): nobody but an admin can
 * connect it, and the card must say who can.
 */
/**
 * Services a template may name but that a person cannot use yet.
 *
 * A template needing one of these is hidden rather than shown with a
 * "Connect" button that leads nowhere. The card would promise an outcome the
 * run cannot deliver, and the person only finds out after installing it.
 *
 * This is a temporary list. Remove a service the day its integration works,
 * and its templates come back with no other change. Keep it empty otherwise:
 * a template whose service is merely NOT CONNECTED belongs in the gallery,
 * because connecting it is exactly what the card asks for.
 */
const SERVICES_NOT_READY: ReadonlySet<string> = new Set();

/** The services a template cannot run without. */
function requiredServices(summary: WorkflowTemplateSummary): string[] {
  return summary.requires.map((r) => r.service);
}

// ─── Team-scoped requirements ────────────────────────────────────────────
//
// A listing taken in a team workspace must answer the question the INSTALL
// answers, and a team install is judged by `teamServiceReadiness` — the
// team's credentials, the org-provided services, and the GitHub App — not
// by the caller's own Integrations list. Judged by the caller, a team that
// holds Linear reads as unconnected, the card withholds Install, and
// connecting Linear personally never changes the answer. So the same
// predicate answers both, and the two agree by construction.

/**
 * What a definition contributes to its readiness answer: for each tool
 * node, the service, the credential pin, and the repository the github
 * branch looks an App installation up under (`installationResolvesFor`
 * reads `owner` and `repo`). Two definitions with the same signature get
 * the same answer, so one call stands in for both.
 *
 * The signature covers every tool node rather than one per service because
 * `teamServiceReadiness` reads a service's nodes TOGETHER: every node
 * pinned `app` takes the App branch, and one node pinned `user` keeps the
 * service on the credential-row path. A template that pins the App and a
 * template that pins the owner's own token therefore get separate answers.
 * Merging them would hide the ready one behind the blocked one.
 */
function readinessSignature(definition: WorkflowDefinition): string {
  const nodes = toolNodesOf(definition).map((node) => {
    const owner = typeof node.params.owner === "string" ? node.params.owner : "";
    const repo = typeof node.params.repo === "string" ? node.params.repo : "";
    // JSON, not a joined string: an `owner` holding the separator would
    // otherwise read as a different node's signature.
    return JSON.stringify([node.service, node.credential ?? "auto", owner, repo]);
  });
  // The callee's own tool nodes are part of the answer, so two definitions
  // that call DIFFERENT workflows must not share one memoized readiness.
  const calls = workflowCallsOf(definition).map((node) => node.workflowId);
  return JSON.stringify([[...new Set(nodes)].sort(), [...new Set(calls)].sort()]);
}

export async function listWorkflowTemplateSummaries(
  deps: TemplateServiceDeps,
  caller: { userId: string; orgId: string },
  /** The team workspace the gallery is showing, when it is showing one.
   * The requirements are then stamped against that team, because that is
   * the principal its Install button would install as. */
  opts: { teamId?: string } = {},
): Promise<WorkflowTemplateSummary[]> {
  const owner: CredentialOwner = { type: "user", id: caller.userId };
  const availability = {
    plugins: deps.plugins,
    orgId: caller.orgId,
    credentials: deps.credentials,
    env: process.env,
  };
  // The same resolver the integrations page, the manual-save gate, the
  // session tool gate and the workflow invoker use, so all five agree on
  // what this deployment can offer.
  const [personal, orgProvided, unavailable] = await Promise.all([
    deps.credentials.list(owner),
    orgProvidedServiceSet(availability),
    unavailableServiceSet(availability),
  ]);
  // A service in "org" mode (e.g. Slack's bot token, connected once in
  // Settings → Organization) is never on any member's OWN credential list —
  // that is the whole point of an org credential. Union it in here, or
  // every card for an org-provided-but-not-personally-connectable service
  // reads "Connect Slack" forever, for every member, including the one who
  // set it up.
  const connected = new Set([...personal.map((cred) => cred.service), ...orgProvided]);

  // The org's model policy, read once for the whole listing. It decides the
  // `installable` flag on each card: the install gate refuses a template
  // whose model this org cannot run, and a card that hides that fact offers
  // an Install button that always fails.
  //
  // Not fatal. A listing that cannot read the policy still lists every
  // card, and each one stays installable — the install gate answers on the
  // install itself, so the worst case is the behavior this flag replaced.
  let orgEnv: ValidateEnvironment | undefined;
  try {
    orgEnv = await buildOrgValidateEnvironment(deps, caller.orgId);
  } catch (err) {
    console.error(
      `workflow templates: could not read the model policy of org ${caller.orgId}; ` +
        "listing every template as installable:",
      err,
    );
  }

  const listed: SummarizeResult[] = [];
  for (const owned of await listCatalogTemplatesForOwner(deps, caller)) {
    const result = summarizeTemplate(owned, deps.actionPluginByService, connected, unavailable);
    if (!result.ok) {
      console.error(
        `workflow templates: hiding "${owned.template.id}" from "${owned.pluginName}" — ` +
          `its definition is invalid: ${result.errors.join("; ")}`,
      );
      continue;
    }
    const blocked = requiredServices(result.value.summary).filter((svc) =>
      SERVICES_NOT_READY.has(svc),
    );
    if (blocked.length > 0) {
      // Not an error. Say it once so the list is explainable when somebody
      // asks where a template went.
      console.info(
        `workflow templates: hiding "${owned.template.id}" — it needs ` +
          `${blocked.join(", ")}, which is not available yet.`,
      );
      continue;
    }
    const reason = orgEnv
      ? orgModelBlockReason(owned.template.id, result.value.definition, orgEnv)
      : null;
    if (reason !== null) {
      result.value.summary.installable = false;
      result.value.summary.installBlockedReason = reason;
    }
    listed.push(result.value);
  }

  const teamId = opts.teamId;
  if (teamId === undefined) return listed.map((entry) => entry.summary);

  // A team workspace restamps `connected` against the team, over the
  // definitions that survived validation. `unconfigured` is unchanged: it
  // is the organization's answer, the same for every member and team.
  //
  // Readiness is a database read per service plus, for github, an App
  // lookup, so it is memoized per signature. Each call still gets the
  // template's REAL definition, so a predicate that grows to read more of
  // it than the tool nodes stays correct here.
  const readinessBySignature = new Map<string, Promise<TeamServiceReadiness>>();
  const summaries: WorkflowTemplateSummary[] = [];
  for (const { summary, definition, githubEvents } of listed) {
    const signature = readinessSignature(definition);
    const pending =
      readinessBySignature.get(signature) ??
      teamServiceReadiness(
        { db: deps.db, credentials: deps.credentials, plugins: deps.plugins, onePassword: deps.onePassword },
        { orgId: caller.orgId, teamId, definition },
      );
    readinessBySignature.set(signature, pending);
    const readiness = await pending;
    // Map the whole closure to credential keys; any blocked alias wins.
    const byService = new Map<string, WorkflowTemplateRequirement>();
    const blocked = new Set(readiness.blocked.map((entry) => entry.service));
    for (const toolService of [...readiness.ready, ...blocked]) {
      const entry = deps.actionPluginByService.get(toolService);
      const { service, dynamic } = entry
        ? credentialServiceFor(entry)
        : { service: toolService, dynamic: false };
      const connected = !blocked.has(toolService) && byService.get(service)?.connected !== false;
      byService.set(service, {
        service,
        connected,
        ...(readiness.organizationProvided?.includes(toolService) ? { organizationProvided: true as const } : {}),
        ...(toolService === "github" && githubEvents
          ? { repositoryCheckOnInstall: true as const } : {}),
        ...(dynamic ? { dynamic: true } : {}),
        ...(unavailable.has(service) ? { unconfigured: true } : {}),
      });
    }
    summaries.push({
      ...summary,
      requires: [...byService.values()],
      blockers: teamArmRefusals(readiness).map((refusal) => refusal.reason),
    });
  }
  return summaries;
}

// ─── Install ─────────────────────────────────────────────────────────────

export interface InstallTemplateInput {
  /** Values for the template's declared inputs, baked into the installed
   * definition. See `bakeInputs` for what "baked" means and why. */
  inputs?: Record<string, unknown>;
  /** Install into a team workspace instead of the caller's own. The caller
   * must be a current member; a non-member or unknown id is not found, the
   * same convention `createWorkflowDefinition` follows. */
  teamId?: string;
}

export type InstallTemplateFailure =
  | { code: "not_found"; error: string }
  | { code: "team_not_found"; error: string }
  | { code: "broken_template"; error: string; errors: string[] }
  | { code: "not_connected"; error: string }
  | { code: "invalid_input"; error: string; errors: string[] };

export type InstallTemplateResult =
  | { ok: true; workflowId: string; workflowName: string; scheduleId?: string; subscriptionIds?: string[] }
  | ({ ok: false } & InstallTemplateFailure);

/**
 * Replaces `{{ trigger.data.<field> }}` with a literal value everywhere in
 * the definition, and drops the field from the trigger's `dataSchema` once
 * nothing references it.
 *
 * This exists because of one runtime fact: a scheduled run puts
 * `{ scheduleName, cron, input }` in `trigger.data` and applies NO
 * `dataSchema` defaults (`scheduler.ts`). A scheduled workflow therefore
 * cannot read a per-install parameter from its trigger — `{{ trigger.data.
 * channelId }}` renders null every night, forever, and nothing reports it.
 * Baking the value into the definition at install time is the only form
 * that works on every entry point.
 *
 * The substitution follows `renderTemplate`'s own rule: a string that is
 * EXACTLY one expression becomes the value with its type intact, and a
 * string with literal text around the expression becomes text. Only a
 * plain `trigger.data.<field>` reference is rewritten — a longer path or
 * an expression over the field is left alone, and the field then stays in
 * `dataSchema` because something still reads it.
 */
export function bakeInputs(
  definition: WorkflowDefinition,
  values: Record<string, string | number | boolean>,
): WorkflowDefinition {
  // Only a plain identifier can be read with dot access in an expression,
  // and only a plain identifier is safe to put in a regular expression.
  // One rule covers both.
  const fields = Object.keys(values).filter((f) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f));
  if (fields.length === 0) return definition;

  const substitute = (source: string): unknown => {
    for (const field of fields) {
      const single = new RegExp(`^\\s*\\{\\{\\s*trigger\\.data\\.${field}\\s*\\}\\}\\s*$`);
      if (single.test(source)) return values[field];
    }
    let out = source;
    for (const field of fields) {
      const all = new RegExp(`\\{\\{\\s*trigger\\.data\\.${field}\\s*\\}\\}`, "g");
      out = out.replace(all, String(values[field]));
    }
    return out;
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return value.includes("{{") ? substitute(value) : value;
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) out[key] = walk(entry);
      return out;
    }
    return value;
  };

  // Re-validated by the caller before anything is written, which is what
  // makes this single narrowing cast safe: `walk` preserves every
  // container's shape and only rewrites leaf strings.
  const baked = walk(definition) as WorkflowDefinition;

  const still = referencedTriggerFields(baked);
  for (const node of baked.nodes) {
    if (node.type !== "trigger" || node.dataSchema === undefined) continue;
    for (const field of fields) {
      if (!still.has(field)) delete node.dataSchema[field];
    }
  }
  return baked;
}

/** Every `trigger.data.<field>` a definition's templates still read. */
function referencedTriggerFields(definition: WorkflowDefinition): Set<string> {
  const fields = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (!value.includes("{{")) return;
      let paths: string[][];
      try {
        paths = collectTemplatePaths(value);
      } catch {
        // An unparseable template is the validator's finding, not this
        // scan's — the caller re-validates the baked definition anyway.
        return;
      }
      for (const path of paths) {
        if (path[0] === "trigger" && path[1] === "data" && path[2] !== undefined) fields.add(path[2]);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const entry of Object.values(value)) walk(entry);
    }
  };
  walk(definition.nodes);
  walk(definition.edges);
  return fields;
}

/**
 * Values to bake, and the fields a scheduled template cannot do without.
 *
 * A scheduled template must carry a value for every required field before
 * it is installed, because its nightly run gets no defaults and no form.
 * A manual template bakes only what the installer supplied, so a batch
 * template keeps collecting its rows at run time.
 */
function resolveInstallValues(
  schema: Record<string, WorkflowInputDefinition> | undefined,
  supplied: Record<string, unknown>,
  /**
   * True when nothing will be there to answer a run form — a cron schedule
   * OR an event subscription. Both build `trigger.data` themselves and merge
   * no `dataSchema` defaults (`scheduler.ts#fire`, `events/dispatcher.ts`
   * #startWorkflow), so every value an unattended run needs has to be
   * resolved here, at install, or it is never resolved at all.
   */
  unattended: boolean,
): { ok: true; values: Record<string, string | number | boolean> } | { ok: false; errors: string[] } {
  const values: Record<string, string | number | boolean> = {};
  const missing: string[] = [];
  if (!schema) return { ok: true, values };

  for (const [field, def] of Object.entries(schema)) {
    const candidate = supplied[field] !== undefined ? supplied[field] : unattended ? def.default : undefined;
    if (candidate === undefined) {
      // A hidden field is one a trigger maps in at fire time (a webhook
      // payload), never one a person types, so it is never "missing".
      if (unattended && def.required === true && def.hidden !== true) missing.push(field);
      continue;
    }
    const primitive = primitiveDefault(candidate);
    if (primitive === undefined) {
      // Only primitives can be written back into a definition as a literal
      // that still renders. Anything else stays a run-time input.
      continue;
    }
    values[field] = primitive;
  }

  if (missing.length > 0) {
    return {
      ok: false,
      errors: missing.map(
        (field) =>
          `Missing value for "${field}". This template runs on its own, and an unattended run applies no input defaults. Supply "${field}" when you install it.`,
      ),
    };
  }
  return { ok: true, values };
}

/**
 * A readiness reason with the install step that follows its fix. Every
 * reason ends with a period (`team-service-readiness.ts`), so the period
 * becomes the join.
 */
function withInstallStep(reason: string): string {
  return withNextStep(reason, "install this template");
}

/**
 * Installs one template as a workflow owned by the caller, or by a team
 * the caller belongs to.
 *
 * Everything that can be refused is refused BEFORE the transaction opens:
 * the template must exist, its definition must validate, the required
 * services must be connected, the inputs must type-check, and the cron
 * must parse. The transaction then only writes.
 */
export async function installWorkflowTemplate(
  deps: TemplateServiceDeps,
  owner: WorkflowOwner,
  templateId: string,
  input: InstallTemplateInput = {},
  now = Date.now(),
): Promise<InstallTemplateResult> {
  const owned = await findTemplateForOwner(deps, owner, templateId);
  if (!owned) {
    return { ok: false, code: "not_found", error: `No template with id "${templateId}". Reload the gallery and try again.` };
  }

  // The same two-source read `listWorkflowTemplateSummaries` makes, and for
  // the same reason: an org-mode service (a Slack bot token an admin
  // connected once in Settings → Organization) is never on any one member's
  // OWN credential list, because sessions resolve it by owner escalation.
  // Reading only the personal list refuses the install of a template whose
  // service the organization already provides — and the gallery, which does
  // union the two, offers an Install button that this gate then rejects.
  const availability = {
    plugins: deps.plugins,
    orgId: owner.orgId,
    credentials: deps.credentials,
    env: process.env,
  };
  const [personal, orgProvided, unavailable] = await Promise.all([
    deps.credentials.list({ type: "user", id: owner.userId }),
    orgProvidedServiceSet(availability),
    unavailableServiceSet(availability),
  ]);
  const connected = new Set([...personal.map((c) => c.service), ...orgProvided]);
  const summarized = summarizeTemplate(owned, deps.actionPluginByService, connected, unavailable);
  if (!summarized.ok) {
    return {
      ok: false,
      code: "broken_template",
      error: `Template "${templateId}" from "${owned.pluginName}" is not a valid workflow, so it cannot be installed. Report the template id.`,
      errors: summarized.errors,
    };
  }

  const schedule = owned.template.schedule;
  const teamId = typeof input.teamId === "string" ? input.teamId : undefined;
  if (teamId !== undefined) {
    // Membership first. The readiness answer below names the services the
    // team holds, and a non-member must see the same refusal whatever the
    // team has connected. The transaction checks again under the lock.
    if (!(await isTeamMember(deps.db, teamId, owner.userId))) {
      return { ok: false, code: "team_not_found", error: `Team not found: ${teamId}. Choose a team you belong to.` };
    }
    // A team install bills the team, not the caller. The per-user
    // Integrations list is the wrong gate: the caller's Gmail does not
    // fund a team run, and an org Slack bot they never connected does.
    // `teamServiceReadiness` is the one predicate (decision 15).
    const readiness = await teamServiceReadiness(
      { db: deps.db, credentials: deps.credentials, plugins: deps.plugins, onePassword: deps.onePassword },
      { orgId: owner.orgId, teamId, definition: summarized.value.definition },
    );
    const refusals = teamArmRefusals(readiness);
    if (refusals.length > 0) {
      // Each reason names who acts: a member connects a team credential, an
      // admin configures the App. A service the ORGANIZATION has not
      // configured is the personal path's case, and takes its message: the
      // Integrations page hides such a service, so only an admin can act.
      // The readiness reason is caller-neutral (the repository sync reads
      // the same predicate), so the step that follows the fix in THIS flow
      // is added here.
      const reasons = refusals.map((refusal) =>
        refusal.service !== undefined && unavailable.has(refusal.service)
          ? `${refusal.service} is not configured for this organization, so this template cannot run yet. An admin sets it up in Settings → Organization.`
          : withInstallStep(refusal.reason),
      );
      return { ok: false, code: "not_connected", error: reasons.join(" ") };
    }
  } else {
    // Two different reasons a requirement is unmet, and they take different
    // corrective actions. A service the CALLER has not connected is fixed on
    // the Integrations page. A service the ORGANIZATION has not configured is
    // not on that page at all (integration-availability design hides it), so
    // sending the reader there is sending them to a screen with no button on
    // it — only an admin can act, in Settings → Organization.
    const unmet = summarized.value.summary.requires.filter((r) => !r.connected);
    const unconfigured = unmet.filter((r) => r.unconfigured === true).map((r) => r.service);
    const unconnected = unmet.filter((r) => r.unconfigured !== true).map((r) => r.service);
    if (unconfigured.length > 0) {
      return {
        ok: false,
        code: "not_connected",
        error:
          `${unconfigured.join(" and ")} is not configured for this organization, so this template cannot run yet. ` +
          `An admin sets it up in Settings → Organization.`,
      };
    }
    if (unconnected.length > 0) {
      return {
        ok: false,
        code: "not_connected",
        // A workflow tool node reads the credential of the run's owner and
        // has no fallback, so an install without these would fail on its
        // first run. "Integrations" is the page that holds the connect
        // control (`web/src/routes/integrations.tsx`, and the nav entry of
        // the same name) — naming any other page sends the reader to a
        // screen with no button on it.
        error: `Connect ${unconnected.join(" and ")} in Integrations, then install this template.`,
      };
    }
  }

  const schema = triggerDataSchema(summarized.value.definition);
  const supplied = input.inputs ?? {};
  // Type-check only what the caller supplied: a template whose inputs are
  // collected at RUN time must still install with none of them.
  const suppliedSchema: Record<string, WorkflowInputDefinition> = {};
  const unknownFields: string[] = [];
  for (const field of Object.keys(supplied)) {
    const def = schema?.[field];
    // A misspelled field would otherwise be accepted and do nothing: the
    // definition keeps reading the field it names, and the value is
    // dropped. Name the fields this template takes instead.
    if (!def) unknownFields.push(field);
    else suppliedSchema[field] = def;
  }
  if (unknownFields.length > 0) {
    const known = Object.keys(schema ?? {});
    return {
      ok: false,
      code: "invalid_input",
      error: "This template does not take one of the inputs supplied. Remove it and install again.",
      errors: unknownFields.map(
        (field) =>
          `"${field}" is not an input of this template. ${known.length > 0 ? `It takes: ${known.join(", ")}.` : "It takes no inputs."}`,
      ),
    };
  }
  const typeCheck = resolveTriggerInput(suppliedSchema, supplied);
  if (typeCheck.errors.length > 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "One or more inputs are the wrong shape. Correct them and install again.",
      errors: typeCheck.errors.map((e) => e.message),
    };
  }

  // An event subscription is as unattended as a cron schedule: the
  // dispatcher builds `trigger.data` from the webhook body and merges no
  // `dataSchema` defaults, so an event template's inputs must resolve here
  // or never.
  const events = owned.template.events ?? [];
  const resolved = resolveInstallValues(schema, supplied, schedule !== undefined || events.length > 0);
  if (!resolved.ok) {
    return {
      ok: false,
      code: "invalid_input",
      error: "This template needs a value for every required input before it can be installed.",
      errors: resolved.errors,
    };
  }

  const definition = bakeInputs(summarized.value.definition, resolved.values);
  const revalidated = validateDefinitionInput(definition, buildValidateEnvironment(deps.actionPluginByService));
  if (!revalidated.ok) {
    return {
      ok: false,
      code: "invalid_input",
      error: "The supplied values produced a workflow that cannot run. Check the values and install again.",
      errors: revalidated.errors,
    };
  }

  // The organization's own model policy, on the SAME environment
  // `POST /api/workflows` validates against. An install writes the row
  // directly, so without this gate an organization whose approved list or
  // provider settings exclude a template's model installs a workflow it can
  // never save again — the editor refuses the first edit and says nothing
  // about how the workflow got there.
  const orgEnv = await buildOrgValidateEnvironment(deps, owner.orgId);
  const orgChecked = validateDefinitionInput(definition, orgEnv);
  if (!orgChecked.ok) {
    // `orgModelBlockReason` names the blocked models and both remedies, and
    // the gallery card shows the same sentence. It answers null when the
    // refusal is not about a model, and the generic line covers that.
    const reason = orgModelBlockReason(templateId, definition, orgEnv);
    return {
      ok: false,
      code: "invalid_input",
      error:
        reason ??
        `Template "${templateId}" produced a workflow this organization cannot save. ` +
          "Read the errors, correct the template, then install again.",
      errors: orgChecked.errors,
    };
  }

  // Cron parsing is pure and runs before the transaction, so an unparseable
  // expression can never leave a definition behind with no schedule.
  let fireAt: number | undefined;
  const timezone = schedule?.timezone ?? DEFAULT_TIMEZONE;
  if (schedule) {
    const next = nextFireAt(schedule.cron, timezone, now);
    if (!next.ok) {
      return {
        ok: false,
        code: "broken_template",
        error: `Template "${templateId}" from "${owned.pluginName}" declares a schedule that cannot be read, so it cannot be installed. Report the template id.`,
        errors: [next.error],
      };
    }
    fireAt = next.at;
  }

  // Subscriptions are resolved and validated BEFORE the transaction, for
  // the reason the cron is: a subscription that cannot be armed must not
  // leave an installed workflow behind that nothing will ever call.
  const workflowId = newWorkflowId("wf");
  // `SubscriptionFilter`, not `SubscriptionFilterRow`: the mention-scope gate
  // may append its injected user filter to the resolved template filters.
  const subscriptions: { name: string; eventKeys: string[]; filters: SubscriptionFilter[] }[] = [];
  for (const event of events) {
    const filters: SubscriptionFilterRow[] = [];
    for (const filter of event.filters ?? []) {
      if (filter.fromInput !== undefined) {
        const supplied = resolved.values[filter.fromInput];
        if (typeof supplied !== "string" || supplied.length === 0) {
          // The template names an input its filter needs, and no usable
          // value arrived. Two different faults reach here, so the message
          // names the field rather than guessing which one it was: a
          // person left it empty, or the template names a field its own
          // `dataSchema` does not declare.
          return {
            ok: false,
            code: "invalid_input",
            error:
              `This template watches for events filtered by "${filter.fromInput}", and no value for it arrived. ` +
              `Supply "${filter.fromInput}" when you install it.`,
            errors: [`Event trigger "${event.name}" needs input "${filter.fromInput}" for its ${filter.field} filter.`],
          };
        }
        filters.push({ field: filter.field, op: filter.op, value: supplied });
        continue;
      }
      if (filter.value === undefined) {
        return {
          ok: false,
          code: "broken_template",
          error: `Template "${templateId}" from "${owned.pluginName}" declares an event filter with no value, so it cannot be installed. Report the template id.`,
          errors: [`Event trigger "${event.name}" has a ${filter.field} filter with neither "value" nor "fromInput".`],
        };
      }
      filters.push({ field: filter.field, op: filter.op, value: filter.value });
    }

    // The workflow id is minted above and unique by construction, so its
    // tail keeps two installs of one template apart in the Triggers list —
    // the same suffix rule the schedule name uses.
    const name = `${event.name} (${workflowId.slice(-6)})`;
    // One gate for validation AND mention scoping (TKAI-299): this insert
    // path must hold the same rules the CRUD writers do, or a template
    // becomes the unscoped back door. A validation failure is worth refusing
    // loudly: the ingest matcher only reads the arriving event's own catalog
    // entry, so an undeclared filter field arms a subscription that matches
    // nothing and reports nothing, forever. No template names
    // `slack.app_mention` today; one that does needs a channel filter (an
    // install input) and a Slack-linked installer.
    const write = await validateSubscriptionWrite(
      deps.db,
      deps.plugins,
      { name, eventKeys: event.eventKeys, filters, target: { kind: "workflow", workflowId } },
      { creatorUserId: owner.userId, anyChannel: false, matchChanged: true },
    );
    if (!write.ok) {
      return {
        ok: false,
        code: "broken_template",
        error: `Template "${templateId}" from "${owned.pluginName}" declares an event trigger that cannot be armed, so it cannot be installed. Report the template id.`,
        errors: [write.error],
      };
    }
    const ingressBlocked = await linearEventArmBlock(deps.db,deps.credentials,owner.orgId,event.eventKeys);
    if (ingressBlocked) return { ok: false, code: "not_connected", error: ingressBlocked };
    subscriptions.push({ name, eventKeys: event.eventKeys, filters: write.filters });
  }

  if (teamId !== undefined) {
    // Webhook delivery needs the organization's App even when tool nodes use
    // a team token. Verify exact repo installation before writing any rows.
    const repositories = new Set<string>();
    for (const subscription of subscriptions) {
      if (!subscription.eventKeys.some((key) => key.startsWith("github."))) continue;
      const repoFilter = subscription.filters.find((filter) => filter.field === "repo" && filter.op === "eq");
      if (!repoFilter || typeof repoFilter.value !== "string") {
        return { ok: false, code: "invalid_input", error: "Choose an exact repository for this team's GitHub trigger.", errors: ["A repository equality filter is required."] };
      }
      repositories.add(repoFilter.value);
    }
    for (const repository of repositories) {
      try {
        if (await githubAppRepositoryAccess({ credentials: deps.credentials, ...deps.github }, owner.orgId, repository)) continue;
      } catch {
        return { ok: false, code: "not_connected", error: "Could not verify organization GitHub App repository access. Retry before installing this template." };
      }
      return { ok: false, code: "not_connected", error: `The organization GitHub App is not installed or is suspended on ${repository}. An admin must grant it repository access in Settings → Organization → GitHub, then install this template.` };
    }
  }

  let workflowName = owned.template.name;
  let scheduleId: string | undefined;
  const subscriptionIds: string[] = [];
  let teamMissing = false;

  await deps.db.transaction(async (tx) => {
    if (teamId !== undefined) {
      // Same advisory lock `createWorkflowDefinition` takes: without it the
      // team's rows can be deleted between this check and the insert, which
      // strands the workflow under an owner nobody can reach.
      await lockTeamForOwnership(tx, teamId);
      if (!(await isTeamMember(tx, teamId, owner.userId))) {
        // Returning here commits an EMPTY transaction — the check runs
        // before any insert, so there is nothing to roll back and no
        // exception to plumb through the caller.
        teamMissing = true;
        return;
      }
    }

    const ownerType = teamId !== undefined ? "team" : "user";
    const ownerId = teamId ?? owner.userId;

    // Repeat installs get a counted name. There is no template_id column
    // to count by, so the count comes from the names already installed —
    // exact match, or the same name with a "(n)" suffix. A race between
    // two installs can produce two rows with one name, which is harmless:
    // names are display text, and every id is unique.
    const siblings = await tx
      .select({ id: workflowDefinitions.id })
      .from(workflowDefinitions)
      .where(
        and(
          eq(workflowDefinitions.ownerType, ownerType),
          eq(workflowDefinitions.ownerId, ownerId),
          or(eq(workflowDefinitions.name, owned.template.name), like(workflowDefinitions.name, `${owned.template.name} (%`)),
        ),
      );
    if (siblings.length > 0) workflowName = `${owned.template.name} (${siblings.length + 1})`;

    await tx.insert(workflowDefinitions).values({
      id: workflowId,
      orgId: owner.orgId,
      ownerType,
      ownerId,
      name: workflowName,
      definition,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(workflowVersions).values({
      id: newWorkflowId("wfv"),
      workflowId,
      version: 1,
      name: workflowName,
      definition,
      createdAt: now,
    });

    if (schedule && fireAt !== undefined) {
      scheduleId = randomUUID();
      await tx.insert(workflowSchedules).values({
        id: scheduleId,
        orgId: owner.orgId,
        // Owner follows the workflow; `created_by` records the installer.
        ownerType,
        ownerId,
        targetKind: "workflow",
        workflowId,
        // The workflow id is minted in this transaction and unique by
        // construction, so its tail is the suffix that keeps two installs
        // of one template apart in the schedules list.
        name: `${schedule.name} (${workflowId.slice(-6)})`,
        cron: schedule.cron,
        timezone,
        enabled: true,
        nextFireAt: fireAt,
        createdBy: owner.userId,
        createdAt: now,
        updatedAt: now,
      });
    }

    // In the SAME transaction as the definition, for the reason the
    // schedule is: a subscription row naming a workflow that does not
    // exist would dispatch forever and fail forever.
    for (const subscription of subscriptions) {
      const id = randomUUID();
      subscriptionIds.push(id);
      await tx.insert(eventSubscriptions).values({
        id,
        orgId: owner.orgId,
        ownerType,
        ownerId,
        name: subscription.name,
        eventKeys: subscription.eventKeys,
        filters: subscription.filters,
        target: { kind: "workflow", workflowId },
        enabled: true,
        createdBy: owner.userId,
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  if (teamMissing) {
    return { ok: false, code: "team_not_found", error: `Team not found: ${teamId}. Choose a team you belong to.` };
  }
  return {
    ok: true,
    workflowId,
    workflowName,
    ...(scheduleId !== undefined ? { scheduleId } : {}),
    ...(subscriptionIds.length > 0 ? { subscriptionIds } : {}),
  };
}
