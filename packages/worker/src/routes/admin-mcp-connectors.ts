import { Hono, type Context } from 'hono';
import { z, type ZodType } from 'zod';
import {
  NotFoundError,
  ValidationError,
  type CreateCustomMcpConnectorRequest,
  type UpdateCustomMcpConnectorRequest,
} from '@valet/shared';
import type { Env, Variables } from '../env.js';
import { adminMiddleware } from '../middleware/admin.js';
import {
  createCustomMcpConnector,
  deleteCustomMcpConnectorCascade,
  listConnectorSummaries,
  updateCustomMcpConnector,
} from '../services/custom-mcp-connectors.js';

type AdminMcpConnectorsContext = Context<{ Bindings: Env; Variables: Variables }>;

const authTypeSchema = z.enum(['none', 'oauth', 'api_key', 'bearer']);
const tokenEndpointAuthMethodSchema = z.enum([
  'none',
  'client_secret_basic',
  'client_secret_post',
  'auto',
]);
const additionalHeadersSchema = z.record(z.string().min(1), z.string());

const createConnectorSchema = z.object({
  displayName: z.string().trim().min(1),
  serverUrl: z.string().trim().min(1),
  authType: authTypeSchema,
  oauthClientId: z.string().trim().min(1).nullable().optional(),
  oauthClientSecret: z.string().optional(),
  oauthTokenEndpointAuthMethod: tokenEndpointAuthMethodSchema.optional(),
  oauthScopes: z.string().nullable().optional(),
  oauthAuthorizationEndpoint: z.string().trim().min(1).nullable().optional(),
  oauthTokenEndpoint: z.string().trim().min(1).nullable().optional(),
  apiKey: z.string().optional(),
  apiKeyHeaderName: z.string().trim().min(1).nullable().optional(),
  apiKeyPrefix: z.string().nullable().optional(),
  additionalHeaders: additionalHeadersSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).strict() satisfies ZodType<CreateCustomMcpConnectorRequest>;

const updateConnectorSchema = z.object({
  displayName: z.string().trim().min(1).optional(),
  serverUrl: z.string().trim().min(1).optional(),
  authType: authTypeSchema,
  oauthClientId: z.string().trim().min(1).nullable().optional(),
  oauthClientSecret: z.string().optional(),
  clearClientSecret: z.boolean().optional(),
  oauthTokenEndpointAuthMethod: tokenEndpointAuthMethodSchema.optional(),
  oauthScopes: z.string().nullable().optional(),
  oauthAuthorizationEndpoint: z.string().trim().min(1).nullable().optional(),
  oauthTokenEndpoint: z.string().trim().min(1).nullable().optional(),
  apiKey: z.string().optional(),
  apiKeyHeaderName: z.string().trim().min(1).nullable().optional(),
  apiKeyPrefix: z.string().nullable().optional(),
  additionalHeaders: additionalHeadersSchema.optional(),
  clearAdditionalHeaders: z.boolean().optional(),
  status: z.enum(['active', 'disabled', 'error']).optional(),
}).strict() satisfies ZodType<UpdateCustomMcpConnectorRequest>;

export const adminMcpConnectorsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();
adminMcpConnectorsRouter.use('*', adminMiddleware);

/**
 * GET /api/admin/mcp-connectors
 * List custom MCP connector summaries with secret fields redacted.
 */
adminMcpConnectorsRouter.get('/', async (c) => {
  const connectors = await listConnectorSummaries(c.get('db'), 'default');
  return c.json({ connectors });
});

/**
 * POST /api/admin/mcp-connectors
 * Create a custom MCP connector owned by the current admin.
 */
adminMcpConnectorsRouter.post('/', async (c) => {
  const body = await parseJsonBody(c, createConnectorSchema);
  const user = c.get('user');
  const connector = await createCustomMcpConnector(c.env, c.get('db'), body, {
    orgId: 'default',
    createdBy: user.id,
  });

  return c.json({ connector }, 201);
});

/**
 * PUT /api/admin/mcp-connectors/:id
 * Update mutable connector metadata and credentials. Service slugs are immutable.
 */
adminMcpConnectorsRouter.put('/:id', async (c) => {
  const { id } = c.req.param();
  const body = await parseJsonBody(c, updateConnectorSchema, { rejectServiceSlugChange: true });
  const connector = await updateCustomMcpConnector(c.env, c.get('db'), id, body);
  if (!connector) throw new NotFoundError('Custom MCP connector', id);
  return c.json({ connector });
});

/**
 * DELETE /api/admin/mcp-connectors/:id
 * Delete a connector and connector-owned runtime state.
 */
adminMcpConnectorsRouter.delete('/:id', async (c) => {
  const { id } = c.req.param();
  await deleteCustomMcpConnectorCascade(c.env.DB, c.get('db'), id);
  return c.json({ ok: true });
});

async function parseJsonBody<T>(
  c: AdminMcpConnectorsContext,
  schema: ZodType<T>,
  options: { rejectServiceSlugChange?: boolean } = {},
): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  if (options.rejectServiceSlugChange && isRecord(raw) && 'serviceSlug' in raw) {
    throw new ValidationError('Custom MCP connector service slug cannot be changed.');
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues[0]?.message ?? 'Invalid custom MCP connector request',
      parsed.error.flatten(),
    );
  }

  return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
