/**
 * Authoritative dag/v1 schema reference.
 *
 * Returns a compact, model-readable description of every valid node
 * type, edge fields, condition operations, template syntax, and id
 * rules. Used by:
 *   • the workflow copilot (system prompt + getNodeSchema tool)
 *   • the workflows.schema orchestrator action
 *
 * Pure / sync / no DB lookups — safe to inline into a prompt.
 */
import { allowedIfOperations } from '../lib/workflow-dag/if-operations.js';
import {
  FOREACH_BODY_NODE_TYPES,
  LEGACY_NODE_TYPE_ALIASES,
  LEGACY_NODE_TYPE_NOTES,
  WORKFLOW_NODE_TYPES,
} from '../lib/workflow-dag/schema.js';

export function getWorkflowSchemaReference() {
  return {
    version: 'dag/v1',
    validNodeTypes: WORKFLOW_NODE_TYPES,
    foreachBodyTypes: FOREACH_BODY_NODE_TYPES,
    legacyNodeTypeAliases: LEGACY_NODE_TYPE_ALIASES,
    removedNodeTypeNotes: LEGACY_NODE_TYPE_NOTES,
    idSyntax: {
      allowedPattern: '^[A-Za-z0-9_-]+$',
      maxLength: 80,
      note: 'Dot notation only works for identifier-safe node IDs. For IDs containing "-", use bracket notation such as {{nodes["tool-1"].data.result}}.',
    },
    templates: {
      delimiters: '{{ expression }}',
      runtimeContext: ['trigger', 'nodes', 'item', 'index'],
      examples: [
        '{{trigger.data}}',
        '{{trigger.data.name}}',
        '{{nodes.prepare.data.message}}',
        '{{nodes["tool-1"].data.issues}}',
        '{{item.title}}',
      ],
      note: 'Use nodes.*, not outputs.*.',
    },
    edges: {
      fields: ['from', 'to', 'fromOutput', 'when'],
      ifBranches: ['true', 'false'],
      note: 'Edges connect top-level node IDs only. Edges from if nodes must set fromOutput to "true" or "false".',
    },
    conditionOperations: {
      string: allowedIfOperations('string'),
      number: allowedIfOperations('number'),
      date: allowedIfOperations('date'),
      boolean: allowedIfOperations('boolean'),
      array: allowedIfOperations('array'),
      object: allowedIfOperations('object'),
      aliases: {
        is_not_empty: 'isNotEmpty',
        is_empty: 'isEmpty',
        not_equals: 'notEquals',
        does_not_exist: 'doesNotExist',
        does_not_contain: 'doesNotContain',
        starts_with: 'startsWith',
        ends_with: 'endsWith',
        matches_regex: 'matchesRegex',
        greater_than: 'greaterThan',
        less_than: 'lessThan',
        greater_than_or_equal: 'greaterThanOrEqual',
        less_than_or_equal: 'lessThanOrEqual',
        is_true: 'isTrue',
        is_false: 'isFalse',
      },
    },
    nodes: [
      {
        type: 'trigger',
        required: ['id', 'type'],
        optional: ['dataSchema'],
        description: 'Represents the invocation source and exposes trigger.data, trigger.metadata, trigger.type, and trigger.timestamp.',
      },
      {
        type: 'llm',
        required: ['id', 'type', 'prompt'],
        optional: ['model', 'system', 'outputSchema', 'temperature', 'maxOutputTokens'],
        description: 'Generate text or structured output. Model IDs use provider:model.',
      },
      {
        type: 'tool',
        required: ['id', 'type', 'service', 'action', 'params'],
        optional: ['summary', 'onPolicyDeny', 'retries'],
        description: 'Call a remote integration action.',
      },
      {
        type: 'set',
        required: ['id', 'type', 'values'],
        optional: [],
        description: 'Write structured values to nodes.<id>.data.',
      },
      {
        type: 'if',
        required: ['id', 'type', 'conditions'],
        optional: ['combinator'],
        description: 'Branch on conditions. Conditions use left, dataType, operation, and optional right. NOT to be confused with "condition" — the node type is literally `if`.',
      },
      {
        type: 'wait',
        required: ['id', 'type', 'mode', 'duration'],
        optional: [],
        description: 'Sleep for a duration. MVP mode is "duration".',
      },
      {
        type: 'approval',
        required: ['id', 'type', 'prompt'],
        optional: ['summary', 'details', 'timeout', 'onDeny'],
        description: 'Pause until a human approves or denies. `prompt` is the human-facing question — it is REQUIRED; do not put it in `summary`.',
      },
      {
        type: 'foreach',
        required: ['id', 'type', 'items', 'body'],
        optional: ['itemAlias', 'indexAlias', 'maxItems', 'concurrency', 'onItemError'],
        description: 'Iterate over an array expression and run one allowed body node per item. Optional maxItems truncates the input array before execution.',
        constraints: {
          bodyTypes: FOREACH_BODY_NODE_TYPES,
          bodyNote: 'Nested if, wait, approval, trigger, and foreach nodes are not supported in foreach body.',
        },
      },
      {
        type: 'orchestrator',
        required: ['id', 'type', 'prompt'],
        optional: ['forceNewThread', 'wait'],
        description: 'Prompt the user orchestrator.',
      },
      {
        type: 'session',
        required: ['id', 'type', 'mode', 'prompt'],
        optional: ['workspace', 'title', 'personaId', 'model', 'repo', 'sessionId', 'threadId', 'forceNewThread', 'wait'],
        description: 'Start a new session or prompt an existing session. mode is "start" or "prompt".',
      },
      {
        type: 'stop',
        required: ['id', 'type'],
        optional: ['outcome', 'output', 'message'],
        description: 'End a branch with optional output.',
      },
    ],
  };
}
