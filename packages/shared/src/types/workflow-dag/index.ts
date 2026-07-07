/**
 * Workflow DAG (`dag/v1`) type definitions.
 *
 * The canonical shape of user-authored workflow definitions interpreted by
 * the Cloudflare Workflow runtime. See docs/specs/workflows.md.
 *
 * Each node type lives in `./nodes/<type>.ts` together with its docs and
 * default factory. Top-level shape (WorkflowDefinition, edges, policy,
 * runtime payloads) lives in `./shape.ts`. This file re-exports both so
 * consumers can `import { ... } from '@valet/shared'` unchanged.
 */

export type { NodeDocs, NodeFieldDoc } from './docs.js';
export * from './shape.js';
export * from './nodes/index.js';
