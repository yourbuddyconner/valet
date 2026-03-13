#!/usr/bin/env bun
/**
 * Runner CLI — entrypoint for the sandbox runner process.
 *
 * Usage:
 *   bun run src/bin.ts \
 *     --opencode-url http://localhost:4096 \
 *     --do-url wss://worker.example.com/ws \
 *     --runner-token <token> \
 *     --session-id <id>
 */

import { parseArgs } from "util";
import { AgentClient } from "./agent-client.js";
import { PromptHandler } from "./prompt.js";
import { startGateway, cleanupAllCloudflared } from "./gateway.js";
import { OpenCodeManager, type OpenCodeConfig } from "./opencode-manager.js";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "opencode-url": { type: "string" },
    "do-url": { type: "string" },
    "runner-token": { type: "string" },
    "session-id": { type: "string" },
    "gateway-port": { type: "string", default: "9000" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`
Valet Runner

Bridges the local OpenCode server and the SessionAgent Durable Object.

Options:
  --opencode-url   URL of the local OpenCode server (e.g. http://localhost:4096)
  --do-url         WebSocket URL of the SessionAgent DO
  --runner-token   Authentication token for the DO WebSocket
  --session-id     Session identifier
  --gateway-port   Auth gateway port (default: 9000)
  -h, --help       Show this help message
`);
  process.exit(0);
}

const opencodeUrl = values["opencode-url"];
const doUrl = values["do-url"];
const runnerToken = values["runner-token"];
const sessionId = values["session-id"];
const gatewayPort = parseInt(values["gateway-port"] || "9000", 10);
const INITIAL_CONNECT_MAX_DELAY_MS = 30_000;
const INITIAL_CONNECT_MAX_ATTEMPTS = 30;
const CONFIG_WAIT_TIMEOUT_MS = 30_000;

// ─── Tool Whitelist ──────────────────────────────────────────────────────
// When a persona has tool whitelisting configured, this stores the whitelist.
// null/undefined = no whitelist, all tools available (backward compatible).
let activeToolWhitelist: {
  services: string[];
  excludedActions: Array<{ service: string; actionId: string }>;
} | null = null;

/**
 * Check if a tool (identified by service and optional actionId) is allowed
 * by the active tool whitelist.
 */
function isToolAllowed(service: string, actionId?: string): boolean {
  if (!activeToolWhitelist) return true; // No whitelist = all tools allowed
  // Check if the service is in the whitelist
  if (!activeToolWhitelist.services.includes(service)) return false;
  // Check if this specific action is excluded
  if (actionId) {
    const excluded = activeToolWhitelist.excludedActions.some(
      (e) => e.service === service && e.actionId === actionId,
    );
    if (excluded) return false;
  }
  return true;
}

/**
 * Parse a toolId string into service and actionId components.
 * Tool IDs typically follow the pattern "service:actionId" or just "actionId".
 */
function parseToolId(toolId: string): { service: string; actionId?: string } {
  const colonIdx = toolId.indexOf(':');
  if (colonIdx > 0) {
    return { service: toolId.substring(0, colonIdx), actionId: toolId.substring(colonIdx + 1) };
  }
  return { service: toolId };
}

if (!opencodeUrl || !doUrl || !runnerToken || !sessionId) {
  console.error("Error: --opencode-url, --do-url, --runner-token, and --session-id are required");
  process.exit(1);
}

// ─── Build Initial OpenCode Config from Environment ──────────────────────

function buildInitialConfig(): OpenCodeConfig {
  const providerKeys: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) providerKeys.anthropic = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) providerKeys.openai = process.env.OPENAI_API_KEY;
  if (process.env.GOOGLE_API_KEY) providerKeys.google = process.env.GOOGLE_API_KEY;

  const tools: Record<string, boolean> = {};
  // Disable Parallel AI tools if the API key is not configured
  if (!process.env.PARALLEL_API_KEY) {
    tools.parallel_web_search = false;
    tools.parallel_web_extract = false;
    tools.parallel_deep_research = false;
    tools.parallel_data_enrichment = false;
  }

  return {
    providerKeys,
    tools,
    instructions: [],
    isOrchestrator: process.env.IS_ORCHESTRATOR === "true",
  };
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[Runner] Starting for session ${sessionId}`);
  console.log(`[Runner] DO URL: ${doUrl}`);

  // Parse the OpenCode port from the URL
  const opencodePort = new URL(opencodeUrl!).port || "4096";
  const workspaceDir = process.env.WORK_DIR || "/workspace";
  const configSourceDir = "/opencode-config";
  const authJsonPath = "/root/.local/share/opencode/auth.json";

  // ─── Create OpenCode Manager (defer start until DO sends config) ────
  const openCodeManager = new OpenCodeManager({
    workspaceDir,
    port: parseInt(opencodePort, 10),
    configSourceDir,
    authJsonPath,
  });

  // Promise that resolves when the first opencode-config message arrives from the DO
  let resolveFirstConfig: ((config: Partial<OpenCodeConfig>) => void) | null = null;
  const firstConfigPromise = new Promise<Partial<OpenCodeConfig>>((resolve) => {
    resolveFirstConfig = resolve;
  });

  // ─── Connect to SessionAgent DO ─────────────────────────────────────
  const agentClient = new AgentClient(doUrl!, runnerToken!);

  // Start auth gateway with callbacks
  startGateway(gatewayPort, {
    onImage: (data, description) => {
      agentClient.sendScreenshot(data, description);
    },
    onSpawnChild: async (params) => {
      const result = await agentClient.requestSpawnChild(params);
      // Notify clients of the new child session for UI updates
      agentClient.sendChildSession(result.childSessionId, params.title || params.workspace);
      return result;
    },
    onTerminateChild: async (childSessionId) => {
      return await agentClient.requestTerminateChild(childSessionId);
    },
    onSelfTerminate: () => {
      agentClient.requestSelfTerminate();
    },
    onSendMessage: async (targetSessionId, content, interrupt) => {
      await agentClient.requestSendMessage(targetSessionId, content, interrupt);
    },
    onReadMessages: async (targetSessionId, limit, after) => {
      const result = await agentClient.requestReadMessages(targetSessionId, limit, after);
      return result.messages;
    },
    onCreatePullRequest: async (params) => {
      return await agentClient.requestCreatePullRequest(params);
    },
    onUpdatePullRequest: async (params) => {
      return await agentClient.requestUpdatePullRequest(params);
    },
    onListPullRequests: async (params) => {
      return await agentClient.requestListPullRequests(params);
    },
    onInspectPullRequest: async (params) => {
      return await agentClient.requestInspectPullRequest(params);
    },
    onReportGitState: (params) => {
      agentClient.sendGitState(params);
    },
    onMemRead: async (path) => {
      return await agentClient.requestMemRead(path);
    },
    onMemWrite: async (path, content) => {
      return await agentClient.requestMemWrite(path, content);
    },
    onMemPatch: async (path, operations) => {
      return await agentClient.requestMemPatch(path, operations);
    },
    onMemRm: async (path) => {
      return await agentClient.requestMemRm(path);
    },
    onMemSearch: async (query, path, limit) => {
      return await agentClient.requestMemSearch(query, path, limit);
    },
    onListRepos: async (source) => {
      return await agentClient.requestListRepos(source);
    },
    onListPersonas: async () => {
      return await agentClient.requestListPersonas();
    },
    onListChannels: async () => {
      return await agentClient.requestListChannels();
    },
    onGetSessionStatus: async (targetSessionId) => {
      return await agentClient.requestGetSessionStatus(targetSessionId);
    },
    onListChildSessions: async () => {
      return await agentClient.requestListChildSessions();
    },
    onForwardMessages: async (targetSessionId, limit, after) => {
      return await agentClient.requestForwardMessages(targetSessionId, limit, after);
    },
    onReadRepoFile: async (params) => {
      return await agentClient.requestReadRepoFile(params);
    },
    onListWorkflows: async () => {
      return await agentClient.requestListWorkflows();
    },
    onSyncWorkflow: async (params) => {
      return await agentClient.requestSyncWorkflow(params);
    },
    onGetWorkflow: async (workflowId) => {
      return await agentClient.requestGetWorkflow(workflowId);
    },
    onUpdateWorkflow: async (workflowId, payload) => {
      return await agentClient.requestUpdateWorkflow(workflowId, payload);
    },
    onDeleteWorkflow: async (workflowId) => {
      return await agentClient.requestDeleteWorkflow(workflowId);
    },
    onRunWorkflow: async (params) => {
      return await agentClient.requestRunWorkflow(
        params.workflowId,
        params.variables,
        {
          repoUrl: params.repoUrl,
          branch: params.branch,
          ref: params.ref,
          sourceRepoFullName: params.sourceRepoFullName,
        },
      );
    },
    onListWorkflowExecutions: async (workflowId, limit) => {
      return await agentClient.requestListWorkflowExecutions(workflowId, limit);
    },
    onListTriggers: async (filters) => {
      return await agentClient.requestListTriggers(filters);
    },
    onSyncTrigger: async (params) => {
      return await agentClient.requestSyncTrigger(params);
    },
    onRunTrigger: async (triggerId, params) => {
      return await agentClient.requestRunTrigger(triggerId, params);
    },
    onDeleteTrigger: async (triggerId) => {
      return await agentClient.requestDeleteTrigger(triggerId);
    },
    onGetExecution: async (executionId) => {
      return await agentClient.requestGetExecution(executionId);
    },
    onGetExecutionSteps: async (executionId) => {
      return await agentClient.requestGetExecutionSteps(executionId);
    },
    onApproveExecution: async (executionId, params) => {
      return await agentClient.requestApproveExecution(executionId, params);
    },
    onCancelExecution: async (executionId, params) => {
      return await agentClient.requestCancelExecution(executionId, params);
    },
    onTunnelsUpdated: (tunnels) => {
      agentClient.sendTunnels(tunnels);
    },
    // Phase C: Mailbox + Task Board
    onMailboxSend: async (params) => {
      return await agentClient.requestMailboxSend(params);
    },
    onMailboxCheck: async (limit, after) => {
      return await agentClient.requestMailboxCheck(limit, after);
    },
    onTaskCreate: async (params) => {
      return await agentClient.requestTaskCreate(params);
    },
    onTaskList: async (params) => {
      return await agentClient.requestTaskList(params);
    },
    onTaskUpdate: async (taskId, updates) => {
      return await agentClient.requestTaskUpdate(taskId, updates);
    },
    onMyTasks: async (status) => {
      return await agentClient.requestMyTasks(status);
    },
    // Phase D: Channel Reply
    onChannelReply: async (channelType, channelId, message, imageBase64, imageMimeType, followUp) => {
      return await agentClient.requestChannelReply(channelType, channelId, message, imageBase64, imageMimeType, followUp);
    },
    // Tool Discovery & Invocation (with whitelist filtering)
    onListTools: async (service, query) => {
      const result = await agentClient.requestListTools(service, query);
      if (activeToolWhitelist && result.tools) {
        result.tools = (result.tools as Array<{ id?: string; service?: string; actionId?: string; [key: string]: unknown }>).filter((tool) => {
          const svc = tool.service || (tool.id ? parseToolId(tool.id).service : undefined);
          const action = tool.actionId || (tool.id ? parseToolId(tool.id).actionId : undefined);
          if (!svc) return true; // Can't determine service, allow through
          return isToolAllowed(svc, action);
        });
      }
      return result;
    },
    onCallTool: async (toolId, params) => {
      // Enforce whitelist on tool invocation
      if (activeToolWhitelist) {
        const { service, actionId } = parseToolId(toolId);
        if (!isToolAllowed(service, actionId)) {
          throw new Error(`Tool "${toolId}" is not available for this persona`);
        }
      }
      return await agentClient.requestCallTool(toolId, params);
    },
    // Skill API
    onSkillApi: async (action, payload) => {
      return await agentClient.requestSkillApi(action, payload);
    },
    // Persona API
    onPersonaApi: async (action, payload) => {
      return await agentClient.requestPersonaApi(action, payload);
    },
  });
  const promptHandler = new PromptHandler(opencodeUrl!, agentClient, sessionId!);

  // Register handlers
  agentClient.onPrompt(async (messageId, content, model, author, modelPreferences, attachments, channelType, channelId, opencodeSessionId, continuationContext, _threadId, replyChannelType, replyChannelId) => {
    console.log(`[Runner] Received prompt: ${messageId}${model ? ` (model: ${model})` : ''}${author?.authorName ? ` (by: ${author.authorName})` : ''}${modelPreferences?.length ? ` (prefs: ${modelPreferences.length} models)` : ''}${attachments?.length ? ` (attachments: ${attachments.length})` : ''}${channelType ? ` (channel: ${channelType})` : ''}${replyChannelType ? ` (replyChannel: ${replyChannelType})` : ''}${continuationContext ? ' (with continuation context)' : ''}`);
    await promptHandler.handlePrompt(messageId, content, model, author, modelPreferences, attachments, channelType, channelId, opencodeSessionId, continuationContext, undefined, replyChannelType, replyChannelId);
  });

  agentClient.onAnswer(async (questionId, answer) => {
    console.log(`[Runner] Received answer for question: ${questionId}`);
    await promptHandler.handleAnswer(questionId, answer);
  });

  agentClient.onStop(async () => {
    console.log("[Runner] Received stop signal, shutting down");
    await openCodeManager.stop();
    agentClient.disconnect();
    process.exit(0);
  });

  agentClient.onAbort(async (channelType, channelId) => {
    console.log(`[Runner] Received abort signal${channelType ? ` (channel: ${channelType}:${channelId})` : ''}`);
    await promptHandler.handleAbort(channelType, channelId);
  });

  agentClient.onInit(async () => {
    console.log("[Runner] Received init from DO");
  });

  agentClient.onRevert(async (messageId) => {
    console.log(`[Runner] Received revert for message: ${messageId}`);
    await promptHandler.handleRevert(messageId);
  });

  agentClient.onDiff(async (requestId) => {
    console.log(`[Runner] Received diff request: ${requestId}`);
    await promptHandler.handleDiff(requestId);
  });

  agentClient.onReview(async (requestId) => {
    console.log(`[Runner] Received review request: ${requestId}`);
    await promptHandler.handleReview(requestId);
  });

  agentClient.onOpenCodeCommand(async (command, args, requestId) => {
    console.log(`[Runner] Received OpenCode command: /${command} (requestId=${requestId})`);
    await promptHandler.executeOpenCodeCommand(command, args, requestId);
  });

  agentClient.onNewSession(async (channelType, channelId, requestId) => {
    console.log(`[Runner] New session requested for ${channelType}:${channelId}`);
    await promptHandler.handleNewSession(channelType, channelId, requestId);
  });

  agentClient.onWorkflowExecute(async (executionId, payload, model, modelPreferences) => {
    console.log(`[Runner] Received workflow execution dispatch: ${executionId} (${payload.kind})`);
    await promptHandler.handleWorkflowExecutionDispatch(executionId, payload, model, modelPreferences);
  });

  agentClient.onTunnelDelete(async (name, actor) => {
    console.log(`[Runner] Received tunnel delete: ${name} (actor=${actor?.name || actor?.email || actor?.id || "unknown"})`);
    try {
      const resp = await fetch(`http://localhost:${gatewayPort}/api/tunnels/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`[Runner] Tunnel delete failed: ${errText}`);
      }
    } catch (err) {
      console.error("[Runner] Tunnel delete error:", err);
    }
  });

  // ─── OpenCode Config Handler ──────────────────────────────────────────
  agentClient.onOpenCodeConfig(async (config) => {
    console.log("[Runner] Received opencode-config from DO");

    // First config: resolve the promise so main() handles the initial start
    if (resolveFirstConfig) {
      console.log("[Runner] First opencode-config received, deferring to boot sequence");
      resolveFirstConfig(config);
      resolveFirstConfig = null;
      return;
    }

    // Subsequent configs: hot-reload via applyConfig (for admin config pushes)
    try {
      promptHandler.setProviderModelConfigs(config.customProviders, config.builtInProviderModelConfigs);
      await promptHandler.handleOpenCodeRestart();
      const result = await openCodeManager.applyConfig(config);
      if (result.restarted) {
        await promptHandler.handleOpenCodeRestarted();
      }
      agentClient.sendOpenCodeConfigApplied(true, result.restarted);
      agentClient.sendAgentStatus("idle");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[Runner] Failed to apply opencode config:", errorMsg);
      agentClient.sendOpenCodeConfigApplied(false, false, errorMsg);
    }
  });

  // ─── Plugin Content Handler ────────────────────────────────────────────
  agentClient.onPluginContent(async (content) => {
    console.log(`[Runner] Received plugin-content: ${content.personas.length} persona(s), ${content.skills.length} skill(s), ${content.tools.length} tool(s), toolWhitelist=${content.toolWhitelist ? `${content.toolWhitelist.services.length} service(s)` : 'none'}`);

    // Store tool whitelist for filtering list-tools and call-tool
    activeToolWhitelist = content.toolWhitelist ?? null;

    const { mkdirSync } = await import('node:fs');
    const baseDir = '/root/.opencode';

    // Write persona files
    if (content.personas.length > 0) {
      const dir = `${baseDir}/personas`;
      mkdirSync(dir, { recursive: true });
      for (const persona of content.personas) {
        await Bun.write(`${dir}/${persona.filename}`, persona.content);
      }
    }

    // Write skill files
    if (content.skills.length > 0) {
      const dir = `${baseDir}/skills`;
      mkdirSync(dir, { recursive: true });
      for (const skill of content.skills) {
        await Bun.write(`${dir}/${skill.filename}`, skill.content);
      }
    }

    // Write tool/plugin files
    if (content.tools.length > 0) {
      const dir = `${baseDir}/plugins/valet`;
      mkdirSync(dir, { recursive: true });
      for (const tool of content.tools) {
        await Bun.write(`${dir}/${tool.filename}`, tool.content);
      }
    }

    console.log('[Runner] Plugin content written to filesystem');
  });

  // ─── Graceful Shutdown ────────────────────────────────────────────────
  const shutdown = async () => {
    console.log("[Runner] Shutting down...");
    cleanupAllCloudflared();
    await openCodeManager.stop();
    agentClient.disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Brief delay before first connection — the sandbox may boot before the Worker
  // finishes calling /start on the DO to store our runner token (race condition).
  console.log("[Runner] Waiting 3s for DO initialization...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Initial connect must be resilient too. If the first websocket upgrade fails
  // (cold start/race/network blip), keep retrying instead of exiting the runner.
  // Cap attempts so stale sandboxes (rotated session, broken network) don't retry forever.
  let initialConnectAttempt = 0;
  while (true) {
    initialConnectAttempt++;
    try {
      await agentClient.connect();
      break;
    } catch (err) {
      if (initialConnectAttempt >= INITIAL_CONNECT_MAX_ATTEMPTS) {
        console.error(
          `[Runner] Initial DO connection failed after ${initialConnectAttempt} attempts — giving up`,
        );
        process.exit(1);
      }
      const delayMs = Math.min(1000 * 2 ** (initialConnectAttempt - 1), INITIAL_CONNECT_MAX_DELAY_MS);
      console.error(
        `[Runner] Initial DO connection failed (attempt ${initialConnectAttempt}/${INITIAL_CONNECT_MAX_ATTEMPTS}). Retrying in ${delayMs}ms:`,
        err,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // ─── Wait for DO config, then start OpenCode (single start) ─────────
  console.log("[Runner] Waiting for opencode-config from DO...");

  const doConfig = await Promise.race([
    firstConfigPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), CONFIG_WAIT_TIMEOUT_MS)),
  ]);

  const initialConfig = buildInitialConfig();

  if (doConfig) {
    console.log("[Runner] Got opencode-config from DO, merging with env config");
    // Merge DO config on top of env-based config
    Object.assign(initialConfig, {
      tools: { ...initialConfig.tools, ...(doConfig.tools || {}) },
      providerKeys: { ...initialConfig.providerKeys, ...(doConfig.providerKeys || {}) },
      instructions: doConfig.instructions ?? initialConfig.instructions,
      isOrchestrator: doConfig.isOrchestrator ?? initialConfig.isOrchestrator,
      customProviders: doConfig.customProviders ?? initialConfig.customProviders,
    });
    // Set provider/model filtering from DO config before model discovery
    promptHandler.setProviderModelConfigs(
      (doConfig as any).customProviders,
      (doConfig as any).builtInProviderModelConfigs,
    );
  } else {
    console.warn("[Runner] Timed out waiting for opencode-config from DO, starting with env-only config");
    // Consume the first-config resolver so late arrivals go through the hot-reload path
    resolveFirstConfig = null;
  }

  console.log(`[Runner] Starting OpenCode with ${Object.keys(initialConfig.providerKeys).length} provider key(s)`);
  await openCodeManager.start(initialConfig);
  console.log(`[Runner] OpenCode URL: ${openCodeManager.getUrl()}`);

  // Discover available models with the full config in place
  const models = await promptHandler.fetchAvailableModels();
  if (models.length > 0) {
    agentClient.sendModels(models);
    console.log(`[Runner] Sent ${models.length} provider(s) to DO`);
  }

  // Ack config to the DO
  agentClient.sendOpenCodeConfigApplied(true, false);

  // Signal readiness AFTER OpenCode is fully started and models discovered.
  // This triggers the DO to drain any queued prompts.
  agentClient.sendAgentStatus("idle");
  console.log("[Runner] Ready — sent initial agentStatus: idle to DO");
}

main().catch((err) => {
  console.error("[Runner] Fatal error:", err);
  process.exit(1);
});
