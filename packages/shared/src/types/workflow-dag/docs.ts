/**
 * Shape of per-node-type documentation. Each entry in NODE_DOCS pairs the
 * runtime type with its author-facing help: short label, one-line summary,
 * long-form markdown, optional per-field clarifications, and optional
 * gotchas to flag in the UI.
 *
 * Field docs are SPARSE on purpose — only add an entry for a field that
 * genuinely needs clarification beyond its label. Fields without an entry
 * render no info-tooltip in the inspector.
 *
 * Generic over the node interface so `fields` is keyof-typed: a typo or a
 * renamed field on the interface fails the build at the docs entry,
 * preserving the colocation contract.
 */
export interface NodeFieldDoc {
  /** Help text shown in the info-icon tooltip next to the field. */
  help: string;
}

// Collapse a union T into its intersection (A | B → A & B). For a non-union
// type the result is identical to T. We need this for discriminated-union
// node types like SessionNode = StartSessionNode | PromptSessionNode: a
// distributive `T extends unknown ? keyof T : never` would compute the right
// keys but TypeScript re-distributes the surrounding record/mapped type
// across the union members, producing a union of records instead of one
// record. `keyof (A & B)` gives `keyof A | keyof B` as a flat, non-deferred
// union, so the surrounding mapped type stays a single object type.
type UnionToIntersection<U> = (U extends unknown ? (x: U) => unknown : never) extends (x: infer I) => unknown
  ? I
  : never;

type DocsFieldKey<T> = Exclude<keyof UnionToIntersection<T>, 'id' | 'type'> & string;

export interface NodeDocs<TNode = unknown> {
  /** Display label (sentence case). Shown in palette and inspector header. */
  label: string;
  /** One-line summary shown in the palette and the inspector subheader. */
  description: string;
  /**
   * Multi-line markdown shown in the inline docs drawer. Use this for the
   * "what does this node do, when do I reach for it, what does its output
   * look like" prose that doesn't fit in a tooltip.
   */
  longDescription: string;
  /**
   * Sparse field → help map. The inspector renders an info icon only for
   * fields that appear here. Keys are constrained to `keyof TNode` (minus
   * id/type) so renaming an interface field fails the build at the docs
   * entry.
   *
   * Mapped-type form (not Partial<Record<…>>) so the distributive
   * DocsFieldKey doesn't re-distribute over the whole record type when
   * TNode is a discriminated-union node like SessionNode — mapped types
   * are non-distributive.
   */
  fields?: { [K in DocsFieldKey<TNode>]?: NodeFieldDoc };
  /**
   * Non-obvious behaviors the user should know about. Surfaced near the
   * top of the docs drawer entry.
   */
  gotchas?: string[];
}
