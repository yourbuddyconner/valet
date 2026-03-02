// ─── MCP Protocol Types ─────────────────────────────────────────────────────

/** An MCP tool definition returned by tools/list. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    destructiveHint?: boolean;
    readOnlyHint?: boolean;
  };
}

/** Result of calling an MCP tool via tools/call. */
export interface McpToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

/** JSON-RPC 2.0 request envelope. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response envelope. */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}
