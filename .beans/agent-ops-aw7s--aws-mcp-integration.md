---
# valet-aw7s
title: AWS MCP Server Integration
status: todo
type: feature
priority: medium
tags:
    - integrations
    - mcp
    - aws
created_at: 2026-03-03T00:00:00Z
updated_at: 2026-03-03T00:00:00Z
---

Add the AWS MCP server as an actions integration, giving agents access to AWS service tools (S3, Lambda, CloudFormation, ECS, CloudWatch, etc.) via the AWS MCP endpoint.

## Problem

AWS exposes a rich set of cloud management tools through their MCP server at `https://aws-mcp.us-east-1.api.aws/mcp`. However, it uses IAM SigV4 request signing for auth — not OAuth or Bearer tokens — which doesn't fit the existing `McpActionSource` auth patterns. We need a custom integration that handles SigV4 signing while reusing the MCP infrastructure.

## Context

### AWS MCP Server

- **Endpoint**: `https://aws-mcp.us-east-1.api.aws/mcp` (Streamable HTTP transport)
- **Auth**: IAM credentials (Access Key ID + Secret Access Key) with SigV4 request signing
- **Official client**: `mcp-proxy-for-aws` binary (stdio transport, handles SigV4 internally)
- **Tools**: ~100+ tools across AWS services (S3, Lambda, CloudFormation, ECS, CloudWatch, IAM, etc.)
- **Docs**: https://docs.aws.amazon.com/aws-mcp/latest/userguide/getting-started-aws-mcp-server.html

### Existing Integration Architecture

The current MCP integration chain:

```
OpenCode tool call → Gateway (port 9000) → Runner → SessionAgent DO
  → IntegrationRegistry → ActionSource (McpActionSource or direct) → External API
```

Two existing MCP patterns:
- **MCP OAuth** (Notion): OAuth flow → Bearer token → HTTP to MCP server
- **No-auth MCP** (DeepWiki): No credentials → HTTP to MCP server

Neither supports SigV4.

## Design

### Recommended Approach: Direct HTTP with SigV4 Signing

Use the Streamable HTTP endpoint directly, signing requests with `@aws-sdk/signature-v4` instead of relying on the `mcp-proxy-for-aws` binary.

### Package: `packages/actions-aws/`

Standard action package structure:

```
packages/actions-aws/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts          # Package entry, re-exports
    ├── provider.ts       # Integration provider config (credential type: api_key pair)
    ├── actions.ts        # Empty — tools discovered dynamically via MCP
    ├── triggers.ts       # Empty — no inbound webhooks from AWS MCP
    └── sigv4.ts          # SigV4 request signing for MCP calls
```

### Auth: SigV4 Signing

AWS MCP requires SigV4-signed requests. Two sub-options:

**Option A — `@aws-sdk/signature-v4` (recommended)**:
Use the official AWS SDK signing package. Lightweight, well-maintained, handles all edge cases.

```typescript
// src/sigv4.ts
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';

export function createSigner(credentials: { accessKeyId: string; secretAccessKey: string }, region = 'us-east-1') {
  return new SignatureV4({
    service: 'mcp',
    region,
    credentials,
    sha256: Sha256,
  });
}

export async function signedFetch(url: string, body: string, signer: SignatureV4): Promise<Response> {
  const parsedUrl = new URL(url);
  const request = {
    method: 'POST',
    protocol: parsedUrl.protocol,
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname,
    headers: {
      'Content-Type': 'application/json',
      host: parsedUrl.hostname,
    },
    body,
  };

  const signed = await signer.sign(request);
  return fetch(url, {
    method: 'POST',
    headers: signed.headers,
    body,
  });
}
```

**Option B — Manual SigV4**: Implement signing from scratch. Not recommended — too many edge cases (canonical request serialization, credential scope formatting, etc.).

### Provider Config

```typescript
// src/provider.ts
export const awsProvider = {
  id: 'aws-mcp',
  name: 'AWS',
  description: 'AWS cloud services via MCP',
  credentialType: 'api_key_pair', // access key + secret key (not OAuth)
  credentialFields: [
    { key: 'accessKeyId', label: 'AWS Access Key ID', required: true },
    { key: 'secretAccessKey', label: 'AWS Secret Access Key', required: true, secret: true },
    { key: 'region', label: 'AWS Region', required: false, default: 'us-east-1' },
  ],
  mcpServerUrl: 'https://aws-mcp.us-east-1.api.aws/mcp',
};
```

### Action Source: `AwsMcpActionSource`

Extends the MCP action source pattern but overrides HTTP transport to use SigV4:

```typescript
// Conceptual — inherits from or wraps McpActionSource
export class AwsMcpActionSource implements ActionSource {
  readonly sourceId = 'aws';

  async listActions(): Promise<ActionDefinition[]> {
    // MCP tools/list via SigV4-signed request
    const response = await this.callMcp('tools/list', {});
    return response.tools.map(convertMcpToolToAction);
  }

  async execute(actionId: string, params: Record<string, unknown>): Promise<ActionResult> {
    const toolName = actionId.replace('aws.', '');
    const response = await this.callMcp('tools/call', { name: toolName, arguments: params });
    return { data: response.content, executed: true };
  }

  private async callMcp(method: string, params: unknown): Promise<any> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params });
    const response = await signedFetch(this.endpoint, body, this.signer);
    const result = await response.json();
    if (result.error) throw new Error(`AWS MCP error: ${result.error.message}`);
    return result.result;
  }
}
```

### Credential Storage

AWS credentials (access key + secret) are stored per-user in the existing credential system:
- User configures AWS credentials in integration settings UI
- Stored encrypted in D1 (same as other integration credentials)
- Injected at tool-call time via `ActionContext`

### Tool Filtering

AWS MCP exposes ~100+ tools. Users should be able to:
- Enable/disable specific tools or tool groups (S3, Lambda, etc.)
- Set per-tool risk levels (e.g., `s3.DeleteBucket` → danger, `s3.ListBuckets` → read)
- Default risk: `write` for mutating tools, `read` for list/describe/get tools

Risk can be auto-derived from tool names:
- `List*`, `Describe*`, `Get*` → `read`
- `Create*`, `Update*`, `Put*` → `write`
- `Delete*`, `Terminate*` → `danger`

## Migration Plan

### Phase 1: Package scaffold + SigV4 signing

1. Create `packages/actions-aws/` with standard structure
2. Add `@aws-sdk/signature-v4` and `@aws-crypto/sha256-js` dependencies
3. Implement `sigv4.ts` with `signedFetch()`
4. Implement basic `AwsMcpActionSource` with `listActions()` and `execute()`
5. Run `make generate-registries`

### Phase 2: Credential flow

1. Add `api_key_pair` credential type support if not already present
2. Add AWS credential fields to integration settings UI
3. Wire credential injection into `AwsMcpActionSource`

### Phase 3: Tool filtering + risk derivation

1. Add auto-risk derivation from tool name patterns
2. Add tool enable/disable per-user or per-org config
3. Add tool catalog UI showing available AWS tools

## Dependencies

- **valet-pa5m (Polymorphic Action Sources)**: Provides the `UnifiedActionRegistry` and `ActionSource` contract. AWS MCP is one action source among many. However, the existing integration framework (`IntegrationRegistry`, `McpActionSource`) may be sufficient without pa5m being fully implemented.

## Open Questions

1. **Direct HTTP vs stdio proxy**: Can we confirm the AWS MCP endpoint accepts direct Streamable HTTP with SigV4 headers? The docs primarily describe the `mcp-proxy-for-aws` binary approach. If direct HTTP doesn't work, we'd need to install the binary in the sandbox image and add stdio transport support.

2. **Regional endpoints**: The endpoint is `us-east-1`. Does AWS offer regional MCP endpoints? Do tools operate in the region of the endpoint or the region configured in credentials?

3. **IAM permissions**: What IAM policy does the user's access key need? Presumably scoped to the specific AWS services they want to use. We should document recommended IAM policies.

4. **Tool count**: With ~100+ tools, the agent's tool list could get unwieldy. Should we support lazy loading (discover tools on demand) or require explicit tool selection during setup?

5. **Session tokens**: Should we support temporary credentials (STS session tokens) in addition to long-lived access keys? This would require an additional `sessionToken` credential field.

## Acceptance Criteria

- [ ] `packages/actions-aws/` package exists with standard structure
- [ ] SigV4 request signing works against `https://aws-mcp.us-east-1.api.aws/mcp`
- [ ] `AwsMcpActionSource.listActions()` discovers AWS tools via MCP `tools/list`
- [ ] `AwsMcpActionSource.execute()` invokes AWS tools via MCP `tools/call`
- [ ] User can configure AWS credentials (access key + secret) in integration settings
- [ ] Auto-risk derivation from tool names (List→read, Delete→danger, etc.)
- [ ] `make generate-registries` picks up the new package
- [ ] `pnpm typecheck` passes
