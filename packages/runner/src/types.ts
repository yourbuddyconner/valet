// ─── Runner ↔ DO WebSocket Protocol ────────────────────────────────────────
//
// All protocol types are defined in @valet/shared and re-exported here
// so runner-internal code can import from a single local module.

export type {
  // Supporting types
  PromptAttachment,
  WorkflowRunResultStep,
  WorkflowRunResultEnvelope,
  WorkflowExecutionDispatchPayload,
  ToolCallStatus,
  AgentStatus,
  DiffFile,
  ReviewFinding,
  ReviewFileSummary,
  ReviewResultData,

  // Protocol message unions
  DOToRunnerMessage,
  RunnerToDOMessage,

  // Utility extraction types
  RunnerMessageOf,
  DOMessageOf,

  // Model discovery types
  ProviderModelEntry,
  ProviderModels,
  AvailableModels,
} from '@valet/shared';

// ─── CLI Config ────────────────────────────────────────────────────────────

export interface RunnerConfig {
  opencodeUrl: string;
  doUrl: string;
  runnerToken: string;
  sessionId: string;
}
