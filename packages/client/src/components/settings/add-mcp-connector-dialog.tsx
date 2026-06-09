import * as React from 'react';
import type {
  CreateCustomMcpConnectorRequest,
  CustomMcpConnector,
  CustomMcpConnectorApiKeyPlacement,
  CustomMcpConnectorAuthType,
  CustomMcpConnectorCredentialScope,
  CustomMcpConnectorTokenEndpointAuthMethod,
  UpdateCustomMcpConnectorRequest,
} from '@valet/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  useCreateCustomMcpConnector,
  useUpdateCustomMcpConnector,
} from '@/api/custom-mcp-connectors';

interface AddMcpConnectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connector?: CustomMcpConnector | null;
}

interface HeaderRow {
  key: string;
  value: string;
}

const fieldClass = 'space-y-1.5';
const labelClass = 'text-sm font-medium text-neutral-700 dark:text-neutral-300';

export function AddMcpConnectorDialog({ open, onOpenChange, connector }: AddMcpConnectorDialogProps) {
  const createConnector = useCreateCustomMcpConnector();
  const updateConnector = useUpdateCustomMcpConnector();
  const isEditing = !!connector;
  const redirectOrigin = typeof window === 'undefined' ? '' : window.location.origin;
  const [displayName, setDisplayName] = React.useState('');
  const [serverUrl, setServerUrl] = React.useState('');
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [authType, setAuthType] = React.useState<CustomMcpConnectorAuthType>('none');
  const [credentialScope, setCredentialScope] = React.useState<CustomMcpConnectorCredentialScope>('org');
  const [status, setStatus] = React.useState<'active' | 'disabled'>('active');
  const [oauthClientId, setOauthClientId] = React.useState('');
  const [oauthClientSecret, setOauthClientSecret] = React.useState('');
  const [clearClientSecret, setClearClientSecret] = React.useState(false);
  const [oauthTokenEndpointAuthMethod, setOauthTokenEndpointAuthMethod] =
    React.useState<CustomMcpConnectorTokenEndpointAuthMethod | 'auto'>('auto');
  const [oauthScopes, setOauthScopes] = React.useState('');
  const [oauthAuthorizationEndpoint, setOauthAuthorizationEndpoint] = React.useState('');
  const [oauthTokenEndpoint, setOauthTokenEndpoint] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [apiKeyPlacement, setApiKeyPlacement] = React.useState<CustomMcpConnectorApiKeyPlacement>('header');
  const [apiKeyHeaderName, setApiKeyHeaderName] = React.useState('X-API-Key');
  const [apiKeyPrefix, setApiKeyPrefix] = React.useState('');
  const [apiKeyQueryParam, setApiKeyQueryParam] = React.useState('');
  const [replaceAdditionalHeaders, setReplaceAdditionalHeaders] = React.useState(false);
  const [clearAdditionalHeaders, setClearAdditionalHeaders] = React.useState(false);
  const [additionalHeaders, setAdditionalHeaders] = React.useState<HeaderRow[]>([{ key: '', value: '' }]);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setDisplayName(connector?.displayName ?? '');
    setServerUrl(connector?.serverUrl ?? '');
    setAdvancedOpen(!!connector && (connector.authType !== 'none' || connector.hasAdditionalHeaders));
    setAuthType(connector?.authType ?? 'none');
    setCredentialScope(connector?.credentialScope ?? 'org');
    setStatus(connector?.status === 'disabled' ? 'disabled' : 'active');
    setOauthClientId(connector?.oauthClientId ?? '');
    setOauthClientSecret('');
    setClearClientSecret(false);
    setOauthTokenEndpointAuthMethod(connector?.oauthTokenEndpointAuthMethod ?? 'auto');
    setOauthScopes(connector?.oauthScopes ?? '');
    setOauthAuthorizationEndpoint(connector?.oauthAuthorizationEndpoint ?? '');
    setOauthTokenEndpoint(connector?.oauthTokenEndpoint ?? '');
    setApiKey('');
    setApiKeyPlacement(connector?.apiKeyPlacement ?? 'header');
    setApiKeyHeaderName(connector?.apiKeyHeaderName ?? (connector?.authType === 'bearer' ? 'Authorization' : 'X-API-Key'));
    setApiKeyPrefix(connector?.apiKeyPrefix ?? '');
    setApiKeyQueryParam(connector?.apiKeyQueryParam ?? '');
    setReplaceAdditionalHeaders(false);
    setClearAdditionalHeaders(false);
    setAdditionalHeaders([{ key: '', value: '' }]);
    setError(null);
  }, [open, connector]);

  const isPending = createConnector.isPending || updateConnector.isPending;

  function collectAdditionalHeaders(): Record<string, string> | undefined {
    const pairs = additionalHeaders
      .map((h) => ({ key: h.key.trim(), value: h.value }))
      .filter((h) => h.key || h.value);
    if (pairs.length === 0) return undefined;
    return Object.fromEntries(pairs.map((h) => [h.key, h.value]));
  }

  function buildPayload(): CreateCustomMcpConnectorRequest | UpdateCustomMcpConnectorRequest {
    const additionalHeadersPayload = collectAdditionalHeaders();
    const base = {
      displayName: displayName.trim(),
      serverUrl: serverUrl.trim(),
      authType,
      status,
    };

    if (authType === 'oauth') {
      return {
        ...base,
        credentialScope,
        oauthClientId: oauthClientId.trim() || null,
        oauthClientSecret: oauthClientSecret.trim() || undefined,
        clearClientSecret: isEditing ? clearClientSecret : undefined,
        oauthTokenEndpointAuthMethod,
        oauthScopes: oauthScopes.trim() || null,
        oauthAuthorizationEndpoint: oauthAuthorizationEndpoint.trim() || null,
        oauthTokenEndpoint: oauthTokenEndpoint.trim() || null,
        additionalHeaders: !isEditing || replaceAdditionalHeaders ? additionalHeadersPayload : undefined,
        clearAdditionalHeaders: isEditing ? clearAdditionalHeaders : undefined,
      };
    }

    if (authType === 'api_key' || authType === 'bearer') {
      return {
        ...base,
        credentialScope,
        apiKey: apiKey.trim() || undefined,
        apiKeyPlacement: authType === 'bearer' ? 'header' : apiKeyPlacement,
        apiKeyHeaderName: authType === 'bearer' ? 'Authorization' : apiKeyPlacement === 'header' ? apiKeyHeaderName.trim() : null,
        apiKeyPrefix: authType === 'bearer' ? 'Bearer' : apiKeyPlacement === 'header' ? apiKeyPrefix.trim() || null : null,
        apiKeyQueryParam: authType === 'api_key' && apiKeyPlacement === 'query' ? apiKeyQueryParam.trim() || null : null,
        additionalHeaders: !isEditing || replaceAdditionalHeaders ? additionalHeadersPayload : undefined,
        clearAdditionalHeaders: isEditing ? clearAdditionalHeaders : undefined,
      };
    }

    return {
      ...base,
      additionalHeaders: !isEditing || replaceAdditionalHeaders ? additionalHeadersPayload : undefined,
      clearAdditionalHeaders: isEditing ? clearAdditionalHeaders : undefined,
    };
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const payload = buildPayload();
    const callbacks = {
      onSuccess: () => onOpenChange(false),
      onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Failed to save connector'),
    };
    if (connector) {
      updateConnector.mutate({ id: connector.id, data: payload as UpdateCustomMcpConnectorRequest }, callbacks);
    } else {
      createConnector.mutate(payload as CreateCustomMcpConnectorRequest, callbacks);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isEditing ? 'Edit MCP Connector' : 'Add MCP Connector'}</DialogTitle>
            <DialogDescription>
              Configure a remote MCP server and how credentials are scoped.
            </DialogDescription>
          </DialogHeader>

        <form className="mt-5 space-y-5" onSubmit={handleSubmit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </Field>
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'disabled')} className={selectClassName}>
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </select>
            </Field>
          </div>

          <Field label="Remote MCP server URL">
            <Input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} required placeholder="https://mcp.example.com/server" />
          </Field>

          {connector && (
            <div className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
              Service slug: <span className="font-mono text-neutral-700 dark:text-neutral-200">{connector.serviceSlug}</span>
            </div>
          )}

          <details
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
            className="rounded-md border border-neutral-200 dark:border-neutral-700"
          >
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-neutral-800 dark:text-neutral-100">
              Advanced settings
            </summary>
            <div className="space-y-4 border-t border-neutral-200 p-4 dark:border-neutral-700">
              <Field label="Auth type">
                <select value={authType} onChange={(e) => setAuthType(e.target.value as CustomMcpConnectorAuthType)} className={selectClassName}>
                  <option value="none">None</option>
                  <option value="oauth">OAuth</option>
                  <option value="api_key">API Key</option>
                  <option value="bearer">Bearer</option>
                </select>
              </Field>

              {authType === 'oauth' && (
                <div className="space-y-4 border-t border-neutral-200 pt-4 dark:border-neutral-700">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Client ID">
                      <Input value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} />
                    </Field>
                    <Field label="Client secret">
                      <Input
                        type="password"
                        value={oauthClientSecret}
                        onChange={(e) => setOauthClientSecret(e.target.value)}
                        placeholder={connector?.hasClientSecret ? '(unchanged)' : ''}
                      />
                    </Field>
                  </div>
                  {connector?.hasClientSecret && (
                    <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                      <Checkbox checked={clearClientSecret} onChange={(e) => setClearClientSecret(e.target.checked)} />
                      Remove client secret
                    </label>
                  )}
                  <Field label="Token endpoint auth">
                    <select value={oauthTokenEndpointAuthMethod} onChange={(e) => setOauthTokenEndpointAuthMethod(e.target.value as CustomMcpConnectorTokenEndpointAuthMethod | 'auto')} className={selectClassName}>
                      <option value="auto">Auto</option>
                      <option value="none">None</option>
                      <option value="client_secret_basic">Client secret basic</option>
                      <option value="client_secret_post">Client secret post</option>
                    </select>
                  </Field>
                  <Field label="Scopes">
                    <Input value={oauthScopes} onChange={(e) => setOauthScopes(e.target.value)} placeholder="openid profile offline_access" />
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Authorization endpoint">
                      <Input value={oauthAuthorizationEndpoint} onChange={(e) => setOauthAuthorizationEndpoint(e.target.value)} />
                    </Field>
                    <Field label="Token endpoint">
                      <Input value={oauthTokenEndpoint} onChange={(e) => setOauthTokenEndpoint(e.target.value)} />
                    </Field>
                  </div>
                  {redirectOrigin && (
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      Redirect URI: <span className="font-mono">{`${redirectOrigin}/integrations/callback`}</span>
                    </div>
                  )}
                </div>
              )}

              {(authType === 'api_key' || authType === 'bearer') && (
                <div className="space-y-4 border-t border-neutral-200 pt-4 dark:border-neutral-700">
                  <Field label="Credential scope">
                    <select value={credentialScope} onChange={(e) => setCredentialScope(e.target.value as CustomMcpConnectorCredentialScope)} className={selectClassName}>
                      <option value="org">Organization key</option>
                      <option value="user">Per-user key</option>
                    </select>
                  </Field>
                  {credentialScope === 'org' && (
                    <Field label={authType === 'bearer' ? 'Bearer token' : 'API key'}>
                      <Input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        required={!connector?.hasApiKey}
                        placeholder={connector?.hasApiKey ? '(unchanged)' : ''}
                      />
                    </Field>
                  )}
                  {authType === 'api_key' && (
                    <>
                      <Field label="API key placement">
                        <select value={apiKeyPlacement} onChange={(e) => setApiKeyPlacement(e.target.value as CustomMcpConnectorApiKeyPlacement)} className={selectClassName}>
                          <option value="header">Header</option>
                          <option value="query">Query parameter</option>
                        </select>
                      </Field>
                      {apiKeyPlacement === 'header' ? (
                        <div className="grid gap-4 sm:grid-cols-2">
                          <Field label="Header name">
                            <Input value={apiKeyHeaderName} onChange={(e) => setApiKeyHeaderName(e.target.value)} required />
                          </Field>
                          <Field label="Prefix">
                            <Input value={apiKeyPrefix} onChange={(e) => setApiKeyPrefix(e.target.value)} placeholder="Token" />
                          </Field>
                        </div>
                      ) : (
                        <Field label="Query parameter">
                          <Input value={apiKeyQueryParam} onChange={(e) => setApiKeyQueryParam(e.target.value)} required placeholder="api_key" />
                        </Field>
                      )}
                    </>
                  )}
                </div>
              )}

              <div className="space-y-3 border-t border-neutral-200 pt-4 dark:border-neutral-700">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className={labelClass}>Additional request headers</div>
                    {connector?.hasAdditionalHeaders && (
                      <div className="text-xs text-neutral-500 dark:text-neutral-400">Configured values are hidden.</div>
                    )}
                  </div>
                  {isEditing && (
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                        <Checkbox checked={replaceAdditionalHeaders} onChange={(e) => setReplaceAdditionalHeaders(e.target.checked)} />
                        Replace
                      </label>
                      <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                        <Checkbox checked={clearAdditionalHeaders} onChange={(e) => setClearAdditionalHeaders(e.target.checked)} />
                        Clear
                      </label>
                    </div>
                  )}
                </div>
                {(!isEditing || replaceAdditionalHeaders) && (
                  <div className="space-y-2">
                    {additionalHeaders.map((header, index) => (
                      <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                        <Input value={header.key} onChange={(e) => updateHeader(index, 'key', e.target.value)} placeholder="X-Tenant" />
                        <Input value={header.value} onChange={(e) => updateHeader(index, 'value', e.target.value)} placeholder="Value" />
                        <Button type="button" variant="secondary" onClick={() => removeHeader(index)} disabled={additionalHeaders.length === 1}>
                          Remove
                        </Button>
                      </div>
                    ))}
                    <Button type="button" variant="secondary" onClick={() => setAdditionalHeaders([...additionalHeaders, { key: '', value: '' }])}>
                      Add Header
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </details>

          {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</div>}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={isPending}>{isPending ? 'Saving...' : isEditing ? 'Save' : 'Add'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  function updateHeader(index: number, field: keyof HeaderRow, value: string) {
    setAdditionalHeaders((headers) => headers.map((header, i) => i === index ? { ...header, [field]: value } : header));
  }

  function removeHeader(index: number) {
    setAdditionalHeaders((headers) => headers.filter((_, i) => i !== index));
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={fieldClass}>
      <div className={labelClass}>{label}</div>
      {children}
    </label>
  );
}

const selectClassName =
  'h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-400 dark:focus:ring-neutral-400';
