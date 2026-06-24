/**
 * Shape of per-node-type documentation. Each entry in NODE_DOCS pairs the
 * runtime type with its author-facing help: short label, one-line summary,
 * long-form markdown, optional per-field clarifications, and optional
 * gotchas to flag in the UI.
 *
 * Field docs are SPARSE on purpose — only add an entry for a field that
 * genuinely needs clarification beyond its label. Fields without an entry
 * render no info-tooltip in the inspector.
 */
export interface NodeFieldDoc {
  /** Help text shown in the info-icon tooltip next to the field. */
  help: string;
}

export interface NodeDocs {
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
   * fields that appear here.
   */
  fields?: Record<string, NodeFieldDoc>;
  /**
   * Non-obvious behaviors the user should know about. Surfaced near the
   * top of the docs drawer entry.
   */
  gotchas?: string[];
}
