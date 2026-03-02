import { z } from 'zod';
import type {
  ActionDefinition,
  ActionSource,
  ActionListContext,
  ActionContext,
  ActionResult,
  RiskLevel,
} from '../integrations/index.js';
import { McpClient } from './client.js';
import type { McpTool } from './types.js';

export interface McpActionSourceOptions {
  mcpUrl: string;
  serviceName: string;
  defaultRiskLevel?: RiskLevel;
}

/**
 * ActionSource backed by an MCP server.
 *
 * Maps MCP tools to ActionDefinitions. Uses raw JSON Schema from MCP
 * (set as `inputSchema`) so tool discovery avoids Zod serialization.
 * The `params` field is set to a permissive `z.record(z.unknown())` —
 * actual input validation happens on the MCP server side.
 */
export class McpActionSource implements ActionSource {
  private client: McpClient;
  private serviceName: string;
  private defaultRiskLevel: RiskLevel;

  constructor(opts: McpActionSourceOptions) {
    this.client = new McpClient({ url: opts.mcpUrl, serviceName: opts.serviceName });
    this.serviceName = opts.serviceName;
    this.defaultRiskLevel = opts.defaultRiskLevel ?? 'medium';
  }

  async listActions(ctx?: ActionListContext): Promise<ActionDefinition[]> {
    const token = ctx?.credentials?.access_token;
    if (!token) {
      // Without credentials we can't call the MCP server; return empty gracefully.
      // This happens in unauthenticated contexts like the policy editor catalog.
      return [];
    }

    let tools: McpTool[];
    try {
      tools = await this.client.listTools(token);
    } catch (err) {
      console.warn(
        `[McpActionSource] ${this.serviceName} listTools failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }

    return tools.map((tool) => this.mapToolToAction(tool));
  }

  async execute(actionId: string, params: unknown, ctx: ActionContext): Promise<ActionResult> {
    const token = ctx.credentials.access_token;
    if (!token) {
      return { success: false, error: `No access token for ${this.serviceName}` };
    }

    // actionId is "service.toolName" — extract the MCP tool name
    const mcpToolName = actionId.startsWith(`${this.serviceName}.`)
      ? actionId.slice(this.serviceName.length + 1)
      : actionId;

    try {
      const result = await this.client.callTool(token, mcpToolName, params);

      if (!result || !result.content) {
        return { success: false, error: 'MCP tool returned empty response' };
      }

      if (result.isError) {
        const errorText = result.content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('\n');
        return { success: false, error: errorText || 'MCP tool returned an error' };
      }

      // Extract text content for the result
      const textParts = result.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text);
      const data = textParts.length === 1 ? textParts[0] : textParts.join('\n');

      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private mapToolToAction(tool: McpTool): ActionDefinition {
    return {
      id: `${this.serviceName}.${tool.name}`,
      name: tool.name,
      description: tool.description || `${this.serviceName} tool: ${tool.name}`,
      riskLevel: this.deriveRiskLevel(tool),
      params: z.record(z.unknown()),
      inputSchema: tool.inputSchema,
    };
  }

  private deriveRiskLevel(tool: McpTool): RiskLevel {
    if (tool.annotations?.readOnlyHint) return 'low';
    if (tool.annotations?.destructiveHint) return 'critical';
    return this.defaultRiskLevel;
  }
}
