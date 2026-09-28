/**
 * Collision detection between event subscriptions (TKAI-294).
 *
 * Every enabled subscription that matches an event fires — the dispatcher has
 * no precedence. So an unfiltered `slack.app_mention` rule silently doubles
 * up every channel-scoped one, and nothing tells the person who saved it.
 * This module is the write-time guardrail: `computeCollisions` compares a
 * candidate subscription against the org's existing enabled rows and reports
 * which ones it would fire alongside.
 *
 * Pure and symbolic — no IO, no event payloads. Overlap is decided from the
 * filter shapes alone, with a "filter A implies filter B" relation over the
 * common ops (`eq`, `in`, `prefix`, `contains`). A `regex` filter is
 * undecidable here: it can prove nothing, so it never yields containment
 * (blocking), only possible overlap (a warning). The check is advisory, not
 * an invariant: a collision that slips past it means double delivery, which
 * the feed makes visible, not corruption.
 *
 * Severity policy (the relation is from the CANDIDATE's point of view):
 *
 * - `equal` / `superset` — the candidate covers everything an existing rule
 *   covers on a shared event key. Saving it clobbers the narrow rule:
 *   **blocking** (409 unless the caller sends `allowCollision`).
 * - `subset` / `partial` — both rules fire for some events: **overlapping**
 *   (the write commits; the response carries the warning).
 * - Two workflow targets pointing at DIFFERENT workflows never collide —
 *   running two distinct workflows off one event is intentional fan-out.
 * - A workflow target never blocks an orchestrator target (or the reverse);
 *   the pair is at most a warning. Blocking is reserved for rules that would
 *   race the same kind of consumer.
 */
import type { EventCatalogEntry } from "@valet/engine";
import { eventKeyMatches, type SubscriptionFilter } from "./match.js";

// Duplicated from mention-scope.ts so this module stays pure (mention-scope
// does IO). `subscriptionMatchesEvent` fails closed on a mention subscription
// with no user filter outside team assistant scope, so such a row cannot collide.
const SLACK_MENTION_KEY = "slack.app_mention";

/** The slice of a target the severity policy reads. Structurally satisfied by
 * `EventSubscriptionTargetWire` and by the stored `target` jsonb. */
export interface CollisionTarget {
  kind: string;
  workflowId?: string;
  assistantId?: string;
  follow?: boolean;
  orchestrator?: "user" | "team" | "org";
}

export interface CollisionCandidate {
  ownerType?: string;
  eventKeys: string[];
  filters: SubscriptionFilter[];
  target: CollisionTarget;
}

export type CollisionRelation = "equal" | "superset" | "subset" | "partial";

export interface Collision<T> {
  subscription: T;
  relation: CollisionRelation;
  /** The concrete catalog keys both subscriptions can fire on. */
  sharedKeys: string[];
}

export interface CollisionReport<T> {
  blocking: Collision<T>[];
  overlapping: Collision<T>[];
}

/** Set(a) ⊆ Set(b), proven symbolically. False means "not provable", not
 * "provably false" — the disjointness check below carries the negative side. */
function filterImplies(a: SubscriptionFilter, b: SubscriptionFilter): boolean {
  const aValues =
    a.op === "eq" && typeof a.value === "string"
      ? [a.value]
      : a.op === "in" && Array.isArray(a.value)
        ? a.value
        : null;
  if (aValues !== null) {
    // An empty `in` list matches nothing; ∅ is a subset of everything.
    switch (b.op) {
      case "eq":
        return aValues.every((v) => v === b.value);
      case "in":
        return Array.isArray(b.value) && aValues.every((v) => (b.value as string[]).includes(v));
      case "prefix":
        return typeof b.value === "string" && aValues.every((v) => v.startsWith(b.value as string));
      case "contains":
        return typeof b.value === "string" && aValues.every((v) => v.includes(b.value as string));
      case "regex":
        return false;
    }
  }
  if (typeof a.value !== "string" || typeof b.value !== "string") return false;
  if (a.op === "prefix") {
    // Every string starting with a.value also starts with b.value / contains it.
    if (b.op === "prefix") return a.value.startsWith(b.value);
    if (b.op === "contains") return a.value.includes(b.value);
    return false;
  }
  if (a.op === "contains") {
    return b.op === "contains" && a.value.includes(b.value);
  }
  return false; // regex proves nothing in either direction.
}

/** Set(a) ∩ Set(b) = ∅, proven symbolically. False means "may overlap". */
function filtersDisjoint(a: SubscriptionFilter, b: SubscriptionFilter): boolean {
  const values = (f: SubscriptionFilter): string[] | null =>
    f.op === "eq" && typeof f.value === "string"
      ? [f.value]
      : f.op === "in" && Array.isArray(f.value)
        ? f.value
        : null;
  const av = values(a);
  const bv = values(b);
  if (av !== null && bv !== null) return !av.some((v) => bv.includes(v));
  // One side is a finite set, the other a prefix/contains predicate.
  const finite = av ?? bv;
  const pred = av !== null ? b : a;
  if (finite !== null && typeof pred.value === "string") {
    if (pred.op === "prefix") return !finite.some((v) => v.startsWith(pred.value as string));
    if (pred.op === "contains") return !finite.some((v) => v.includes(pred.value as string));
    return false; // regex: undecidable, assume they may overlap.
  }
  if (a.op === "prefix" && b.op === "prefix") {
    // Two prefixes intersect exactly when one extends the other.
    return (
      typeof a.value === "string" &&
      typeof b.value === "string" &&
      !a.value.startsWith(b.value) &&
      !b.value.startsWith(a.value)
    );
  }
  // prefix×contains and contains×contains always share a member (concatenate
  // the values); regex is undecidable. Either way: may overlap.
  return false;
}

/** All constrained fields of one filter list, deduped. */
function constrainedFields(filters: SubscriptionFilter[]): Set<string> {
  return new Set(filters.map((f) => f.field));
}

/**
 * Set(A) ⊆ Set(B) for one field's constraint lists, where each list is a
 * conjunction. Sufficient, not complete: Set(A) = ∩aᵢ, so one aᵢ ⊆ b proves
 * ∩aᵢ ⊆ b. An empty B is the universe, so anything is a subset of it.
 */
function fieldSubset(a: SubscriptionFilter[], b: SubscriptionFilter[]): boolean {
  return b.every((bf) => a.some((af) => filterImplies(af, bf)));
}

/** The candidate↔existing relation of two filter conjunctions, or null when
 * some field is provably disjoint (the pair can never both fire). */
function filterRelation(
  cand: SubscriptionFilter[],
  exist: SubscriptionFilter[],
): CollisionRelation | null {
  const fields = new Set([...constrainedFields(cand), ...constrainedFields(exist)]);
  let candSubset = true;
  let existSubset = true;
  for (const field of fields) {
    const c = cand.filter((f) => f.field === field);
    const e = exist.filter((f) => f.field === field);
    if (c.some((cf) => e.some((ef) => filtersDisjoint(cf, ef)))) return null;
    if (!fieldSubset(c, e)) candSubset = false;
    if (!fieldSubset(e, c)) existSubset = false;
  }
  if (candSubset && existSubset) return "equal";
  if (existSubset) return "superset";
  if (candSubset) return "subset";
  return "partial";
}

/**
 * The concrete catalog keys BOTH subscriptions can actually fire on. A key
 * is dropped when either side can never match it: a filter on a field the
 * key's catalog entry does not declare fails closed in `filtersMatch`, and a
 * non-team mention subscription without a `user` filter fails closed in
 * `subscriptionMatchesEvent`.
 */
function effectiveSharedKeys(
  cand: CollisionCandidate,
  exist: CollisionCandidate,
  catalog: EventCatalogEntry[],
): string[] {
  const canFire = (sub: CollisionCandidate, entry: EventCatalogEntry): boolean => {
    const filters = effectiveFilters(sub);
    // An empty `in` list never passes, so the whole conjunction never does.
    if (filters.some((f) => f.op === "in" && Array.isArray(f.value) && f.value.length === 0)) {
      return false;
    }
    if (!filters.every((f) => entry.filters.some((cf) => cf.field === f.field))) return false;
    if (entry.key === SLACK_MENTION_KEY && !teamMention(sub) && !sub.filters.some((f) => f.field === "user")) {
      return false;
    }
    return true;
  };
  return catalog
    .filter((entry) => eventKeyMatches(entry.key, cand.eventKeys))
    .filter((entry) => eventKeyMatches(entry.key, exist.eventKeys))
    .filter((entry) => canFire(cand, entry) && canFire(exist, entry))
    .map((entry) => entry.key);
}

/** Blocking, overlapping, or no collision at all — the policy table from the
 * module header, applied to one pair. */
function severity(
  cand: CollisionTarget,
  exist: CollisionTarget,
  relation: CollisionRelation,
): "blocking" | "overlapping" | null {
  if (cand.kind === "workflow" && exist.kind === "workflow") {
    if (cand.workflowId !== exist.workflowId) return null;
  } else if (cand.kind !== exist.kind) {
    return "overlapping";
  }
  return relation === "equal" || relation === "superset" ? "blocking" : "overlapping";
}

/** Team membership replaces stored creator filters, including interim rows. */
function teamMention(sub: CollisionCandidate): boolean {
  return sub.target.kind === "orchestrator" &&
    (sub.ownerType === "team" || (sub.ownerType === undefined && sub.target.orchestrator === "team")) &&
    eventKeyMatches(SLACK_MENTION_KEY, sub.eventKeys);
}

function effectiveFilters(sub: CollisionCandidate): SubscriptionFilter[] {
  return teamMention(sub) ? sub.filters.filter((f) => f.field !== "user") : sub.filters;
}

/**
 * Compares a candidate subscription against existing rows and reports every
 * collision. The caller passes the rows to compare against — enabled rows in
 * the same org, minus the row being edited. Rows the candidate would clobber
 * land in `blocking`; rows it would merely double up with land in
 * `overlapping`.
 */
export function computeCollisions<
  T extends { eventKeys: string[]; filters: SubscriptionFilter[]; target: CollisionTarget },
>(candidate: CollisionCandidate, existing: readonly T[], catalog: EventCatalogEntry[]): CollisionReport<T> {
  const report: CollisionReport<T> = { blocking: [], overlapping: [] };
  for (const sub of existing) {
    const sharedKeys = effectiveSharedKeys(candidate, sub, catalog);
    if (sharedKeys.length === 0) continue;
    const relation = filterRelation(effectiveFilters(candidate), effectiveFilters(sub));
    if (relation === null) continue;
    const kind = severity(candidate.target, sub.target, relation);
    if (kind === null) continue;
    report[kind].push({ subscription: sub, relation, sharedKeys });
  }
  return report;
}
